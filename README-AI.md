# README-AI — dsh-review-hub（给 AI 代理读的规格说明）

> 人类读者请回 [README.md](README.md)（中文）或 [README-EN.md](README-EN.md)（英文）。
> 本文是**实现规格**：红线、结构、数据契约、协议、状态机、失败模式。改代码前必须读完 §2；想动手改功能再读 [AGENT.md](AGENT.md)。
> 版本：**1.0.11**（与 `package.json` 的 `version` 同步；发版时一并改这里）。所有结论都有代码位置或测试作为依据，不要凭"看起来合理"去改行为。
> 同类插件的逐个拆解（机制、版本号、下载量）在 `RESEARCH.md` §4，**采集于 2026-11-03**，引用前先按其中的刷新方式复核版本。

---

## 1. 一句话模型

`approval/request` 是一条瀑布链，**本插件是链上唯一的 answerer**。因此每条记录的 `decidedBy` 是**事实**而非推断。

**层序固定，先命中者独占**（`src/index.js` 的 answerer 主体，约 279–350 行）：

```
L0 硬风险（classify/hardRisk）→ 记忆（decideMemory）→ 文件级（fileArmed + fileCount）→ AI（maybeReview）→ 人工（await next()）
```

顺序是语义，不是实现细节：**确定性在概率之前**。记忆命中时 `maybeReview` 根本不会被调用，所以「`decidedBy === 'memory'` 且带 `aiSource`」是**不可达组合**——任何基于"AI 打回后再被记忆放行"的推理都是错的。

| `decidedBy` | 触发条件 | 代码位置 |
|---|---|---|
| `memory` | 记忆计数 ≥ `settings.threshold`，或文件级命中 | `src/index.js` → `decideMemory` / `fileArmed` 分支 |
| `ai` | reviewer 返回 `allow` | `src/index.js` → `maybeReview` |
| `human` | 我们 `await next()`，耗时 ≥ 300ms 且有结果 | `answerer` 的 `else` 分支 |
| `external` | `next()` 在 <300ms 内返回（人不可能这么快） | 同上，`HUMAN_MIN_MS = 300` |
| `fallback` | `unavailable` / `cancelled` / 抛错 | 同上 |

`counters.external` 必须**恒为 0**；非 0 = 链上还有第二个 answerer。

---

## 2. 红线（违反任何一条都属于破坏性改动）

1. **不接管必须 `return next()`**。漏掉 = 宿主原生面板收不到请求 = 审批以 `unavailable` 关闭（等于拒绝）。
2. **AI 无否决权**。`review.js` 的 `parseVerdict` 把 `deny` 降级为 invalid → `ask`。不要加回 deny。
3. **只有 `decidedBy === 'human' && outcome === 'allowed-once'` 才 `memoryBump`**。AI/记忆通过不得计数。
4. **硬风险先于指纹**：`classify()` 用**原始 argsText**，必须在 `fingerprintOf()` 之前；硬风险不进记忆、不送 reviewer。
5. **记忆按会话隔离**（key = `sessionId\0fp`）；AI 裁决缓存按 `agentKind\0fp` 跨会话。两者语义不同，别"顺手统一"。
6. **绝不追加会话事件**。撤销 = 投递一条用户消息，且**必须带 `id`**（缺 id 会导致会话日志无法加载、会话从侧栏消失）。
7. **插件不写用户文件**：磁盘写只允许 `~/.dsh/storages/review-hub/`。
8. **HTTP 面同源围栏**：`isTrusted()` 校验 loopback + `origin/referer`；不要放宽。
9. **客户端 loader 的 `id` 必须等于包名** `dsh-review-hub`（否则 web boot 直接失败：`duplicate factory registration`）。
10. **`webServer` 路由 disposer 必须挂 `ctx.effect`**，重复注册会抛错（热重载场景）。
11. **`ctx.llm` 只能通过 `ctx.inject(['llm'], …)` 取**：直接读未声明服务会抛，异常被吞后 AI 层静默失效（症状：`aiSource=unavailable`）。
12. **指纹"旋钮清单"只进不出**，见 `store.js` 的 `KNOB_KEYS` 注释：清单是"要删的键"，未知键默认保留（误合并 = 没批过的操作被自动放行）。
13. **不要在客户端往宿主的审批子席位注册**（`conversation.approval.detail` 一类，或任何"注入审批框内部"的做法）。试过两次，两次都在重启后 web boot 失败，删掉插件 link 才恢复——宿主对审批区的注入像是有防篡改保护。需要额外可见性就走 `document.body` 上的浮层（见 §6）。

---

## 3. 文件与职责

```
src/index.js        唯一 answerer / 归属判定 / 记忆计数 / pending 广播 / 路由装配 / SSE 数据源
src/policy.js       L0 硬风险 6 类正则、per-tool 策略表、tier 计算、DEFAULT_AI_TOOLS（写死的 AI 基线）与 toolsPolicyOf({aiTools, aiToolsDeny})（追加/黑名单，黑名单优先，记忆档不受两者影响）
src/agentPolicy.js  按请求方分档（default|subagent|scheduled|task_board|unknown → full|strict|off）
src/catalog.js      宿主真实模型目录（`/models` 的 providers；单 provider 1.5s 超时、60s 缓存、llm 缺失当常态不抛）
src/evidence.js     PTC 感知取参（tool/ptc-dispatch-start → tool/call → reason）、脱敏、240 字符摘要
src/review.js       L3：llm.stream 调用、timeout/熔断/预算、裁决缓存（落盘）、按车道统计
src/store.js        entries/memory/settings 持久化（原子写）、指纹 v2、subscribe/announce 实时订阅
src/snapshot.js     写前快照（tools/pre-execute，只观察）、由参数推出 afterHint
src/diff.js         纯函数 unified diff（双行号；行对象是 {kind,noOld,noNew,text}）
src/routes.js       HTTP 面（含 SSE /stream）
src/export.js       CSV(RFC4180 + BOM + CRLF) / JSON 台账
src/client.js       浏览器半身：三席位 + 右侧栏 diff tab + 设置 UI + 实时中枢 + body 级 AI 建议浮层（单文件 bundle）
test/               run.mjs 汇总；units / pipeline / p3 / client.smoke 四组
```

### 宿主 seam

| seam | 用途 | 关键约束 |
|---|---|---|
| `ctx.on('approval/request', answerer, { prepend: true })` | 唯一裁决点 | 必须 `return next()` 或返回授权结果 |
| `ctx.on('tools/pre-execute', hook)` | 写前快照 | **同步**（快照必须早于工具写入）、只观察、永远 `next()` |
| `ctx.inject(['llm'], …)` | reviewer 模型 | 缺失 → AI 层转人工 |
| `ctx.inject(['webServer'], …)` | HTTP 面 | disposer 挂 `ctx.effect` |
| `ctx.inject(['agents'], …)` | 撤销投递 / 会话标题 | 可选，缺失只降级 UI |

### 客户端席位

| 席位 | 用途 | 参数 |
|---|---|---|
| `conversation.input.dock` | 提示卡 + **实时中枢**（唯一常驻） | `order: 30`，`inject: (sessionId) => ({ sessionId })` |
| `conversation.view` | 「审批」时间线 | `id: 'review-hub.view'`，`order: 20`；红点靠**重注册**改 `label` |
| `sidebar.right.pane.tab` | 右侧栏 diff 面板 | `key` 必须等于 tab 类型 id（`review-hub-diff`） |
| `sidebarRightTabs` / `sidebarRight` | 注册 tab 类型 / 打开 tab | 可选服务，缺失则 diff 退回行内 |
| `plugins.bundle.config` | 插件页卡片（高级设置） | `key/locale: 'dsh-review-hub'` |

> `conversation.composer.dock` 渲染在 **InputBar 内部下方**；要显示在输入框上方必须用 `conversation.input.dock`（宿主 `composerStack` 里 `renderSlot('input.dock')` 在 `inputBar` 之前）。
> `conversation.view` 的 `label` 最终落进 DOM 文本（`resolveSlotLabel`），**不能是 React 节点**；宿主只在 slot 表/locale 变化时刷新 tab 列表，所以改标签必须重注册席位。

---

## 4. 数据契约

根目录 `~/.dsh/storages/review-hub/`（`DSH_HOME` 优先），原子写（`tmp + rename`），写失败只降级为内存态（`health.writable=false`）。

```
entries.json   { version, sessions: { sid: [row ≤ maxEntriesPerSession] }, cleared: { sid: ts } }
memory.json    { version, entries: { "sid\0fp": { toolName, summary, count, firstTs, lastTs, calls[], material, fpMode, droppedKeys[] } } }
settings.json  全部设置（含 hintMs、agentPolicy、aiTools / aiToolsDeny、fileAutoPass、reviewerModelLocal、threshold —— 新增字段必须同时进 store.js 的 clampSettings 与 routes.js 的 CONFIG_FIELDS，否则保存会被静默丢弃）
ai-cache.json  { version, entries: [{ cacheKey, at, verdict }] }（5s 节流写，环形 200，按 TTL 淘汰）
snapshots/<sid>/index.json  { callId: { path, before, afterHint?, bytes, ts, toolName, tooLarge? } }
```

`row`（写入 `entries`）关键字段：

```
id, ts, sessionId, toolName, callId?, outcome(allowed-once|rejected|cancelled|unavailable),
decidedBy(ai|memory|human|external|fallback), decisionMs, riskLevel(low|medium|high|unknown),
riskRule?(delete|discard|credentials|remote-exec|system|batch), argsSummary?, argsTruncated?,
reason?, aiReason?, aiSource?, aiModel?, memoryCount?, agentKind?, tier?, clampedBy?,
filePath?, fileDelta?{add,del}, threshold, routeModel?, hasSnapshot?,
fpMode?(normalized|exact), droppedKeys?, note?
```

浏览器侧只有两个水位（localStorage）：

| key | 语义 |
|---|---|
| `review-hub:floor:<sid>` | 提示卡基线：`ts ≤ floor` 一律不出卡（修"重启重放历史"） |
| `review-hub:seen:<sid>` | 已读水位：`ts > seen` 且 `decidedBy ∈ {ai,memory,external}` 计入红点 |

---

## 5. HTTP / SSE 契约

前缀 `/api/review-hub`，全部走 `isTrusted` 同源围栏。

| 路由 | 方法 | 说明 |
|---|---|---|
| `/health` | GET | `{version, answerer:{registered,counters,reviewer}, pending, store, settings}` |
| `/entries?session=&since=&limit=` | GET | `{entries, cursor, degraded}`，每行附 `hasSnapshot` |
| `/stats?session=` | GET | 计数 + `reviewer`（`byModel` 分车道） |
| `/pending?session=` | GET | 待人工列表（含 `aiReviewed/aiRisk/aiReason`） |
| `/memory?session=` | GET/POST | `op=clear|remove` |
| `/config` | GET/POST | 白名单字段 + `clampSettings` |
| `/clear` | POST | 需 `session` + `settings.clearEnabled === true`，否则 403 |
| `/diff?session=&callId=` | GET | `{ok, path, stats, hunks, drifted}`；降级原因用 200 + `ok:false` |
| `/revert` | POST | 投递指令；消息必须带 `id` |
| `/export` | GET | CSV/JSON |
| `/models?session=&refresh=1` | GET | `{providers:[{id,name,models:[{id,name}]}], observed[], models[], current, errors[], fetchedAt}`（`providers` 来自宿主 llm 目录，单 provider 1.5s 超时、60s 缓存；`models` 是 `observed` 的别名，向后兼容） |
| `/stream?session=` | GET | SSE |

SSE 帧：

```
event: ready     {"session":"…"}
event: entries   {"rows":[row,…]}     ← 突发合并（120ms 窗口），客户端必须优先按数组处理
event: entry     {"row": row}         ← 单条兼容路径
event: pending   {"pending":[…]}
event: other     {"sessionId","title","decidedBy","ts","toolName","id","outcome"}   ← 别的会话，不含内容
: ping                                 ← 30s 心跳
```

实现要点：gzip 中间件**显式跳过** `text/event-stream`；webserver 无响应超时；`write()` 返回值被检查（背压时先丢心跳）；每条记录只 `JSON.stringify` 一次。

---

## 6. 客户端状态机

- **dock 是唯一常驻组件**：它持有 SSE、基线、未读、红点与提示卡的计时器；「审批」页只是同一份 `store` 的视图。
- 连接策略：一条 SSE；`onerror` → `store.streaming=false` + 3s 兜底轮询（`/entries?session=`+`/pending?session=`+`/stats`）；`document.hidden` → 主动 `close()`，`visibilitychange` 回可见先补一次增量再重连。
- **基线**：首次加载取 `max(ts)` 作为 floor（并把这批 id 标记为已出卡），之后只有 `ts > floor` 的记录可能出卡。
- **未读/分割线**：见 §4 的水位；离开「审批」标签时把当前 `max(ts)` 写入 `seen`。
- **重挂载副作用**：改标签会重注册 `conversation.view`（id/order 不变，300ms 防抖），页面会重挂载、滚动复位；数据都在模块级 `store` 里。
- **切会话必须清**：`entries / cursor / stats / diff / revertArmed`（否则会显示上一个会话的行，且 `since=cursor` 永远补不回旧行）。
- 真正的轮询在 `HintBar` 的 effect 里，`ensurePolling/tick` 是**死代码**（诊断时先 grep 调用者）。
- **AI 建议浮层**：`syncAdviceOverlay()` 在 HintBar 渲染时同步一个 `document.body` 子节点（`position:fixed`、`z-index:2147483000`），内容是「等待审批 + 工具/参数 + AI 建议」。它是唯一不受宿主审批面板遮挡的通道；审批页可见（`store.pageVisible`，由 IntersectionObserver 判定而非挂载态）或决策落地时隐藏，组件卸载时移除节点。
- **提示卡只在所属会话显示**：渲染时按 `sessionId` 过滤（模块级 store 跨会话存活）；未读计数同样按会话过滤，否则切走会话徽标不归零。

---

## 7. 失败模式（全部良性地转人工）

| 场景 | 行为 | 记录痕迹 |
|---|---|---|
| 无 `llm` 服务 | 转人工 | `aiSource=unavailable` |
| 超时 / 非法 JSON / 熔断 / 预算用尽 | 转人工 | `aiSource ∈ {error,unparsed,breaker,budget}` |
| 硬风险命中 | 不送 AI、不进记忆 | `riskLevel=high` + `riskRule` |
| 磁盘写失败 | 内存态继续 | `health.writable=false` |
| 决策缓存过期 | 重新调用模型 | —— |
| `/diff` 无快照/过大/二进制 | `ok:false, reason` | —— |
| 撤销时无 agent | `ok:false, reason:'no-agent'` | —— |

---

## 8. 验证与交付门槛

```bash
node --check src/*.js        # 语法（client.js 是字符串 bundle，语法错误会炸整个 web boot）
node test/run.mjs            # 96 用例，必须全绿
```

测试覆盖（摘要）：

- `units`：硬风险 6 类、指纹 v2（旋钮剥离、未知键保留、语义字段永不删、硬风险不受影响）、证据/脱敏、导出字段；
- `pipeline`：五种归属、会话隔离、硬风险不进 AI/记忆、熔断、快照钩子永远 `next()`；
- `p3`：快照三种边界、diff 四种降级 + `drifted`、撤销消息必须带 `id`、`/entries` 的 `hasSnapshot`；
- `client.smoke`：loader `id`、三席位（dock 必须带 `inject`）、zh/en 键数对等、样式与 CSS 变量、`__test` 纯函数（`shouldHint/unreadCount/dividerAt/hintMsOf`）。

改任何宿主侧文件后**必须重启宿主**才生效（服务端半身加载时绑定）；客户端半身刷新页面即可。

---

## 9. 安装/卸载的坑（服务端）

1. 用 `link:` 依赖 + `bundles` 行，不要 `npm install` 到全局；
2. bundled pnpm `install --lockfile-only`，**禁止全量 install**（会清掉 `better-sqlite3` 等原生构建）；
3. `node_modules/<pkg>` 用 junction 指向源码目录；
4. `cordis.patch.yml` 里带 `name:` 的补丁行会在 bundle 行删除后**继续挂载**该插件 → 两个 answerer → 全 `external`；
5. `profile/package.json` 在该机器上原子写会失败（`Win32 1175`），需要直接 `fs.writeFile`；
6. 启动失败先读 `%APPDATA%@deepseek-ai/dsh-desktop/logs/crash-*-web-boot.log`。

---

## 10. 术语

- **answerer**：注册在 `approval/request` 瀑布上的裁决者。
- **硬风险（L0）**：删除 / 丢弃改动 / 凭据 / 远程执行 / 系统级 / 批量破坏。
- **指纹**：`sha1(toolName + \0 + shrinkPaths(material))`；memory 键是 `sessionId\0fp`。
- **旋钮（knob）**：`limit/offset/page/size/count/max_results/since/until/recent/timeout/timeoutMs/graceMs` —— 指纹前被删除，清单只进不出。
- **基线水位（floor）** / **已读水位（seen）**：见 §4。
- **afterHint**：由工具参数推出的"这次写进去的内容"，用作 diff 的右半边（磁盘当前内容会被后续调用改掉）。
