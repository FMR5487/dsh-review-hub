# dsh-review-hub 计划书 — AI 审批层 + 记忆层 + 审批 UI 三合一重构

> 状态：已批准（2026-11-03）。事实基线见 `RESEARCH.md`，证据采集方式与可复现命令都在那份文件里。
> 旧插件 `dsh-auto-review` / `（自用的）学习插件` / `dsh-（自用的）面板插件` 在 P4 之前一律不动，随时可回退。
>
> **v2 变更（2026-11-03）**：并入三项能力 —— ① 待人工时弹 **toast 通知**（设置里可开关）② **台账导出**（CSV/JSON）③ **按 agent 分档**（子代理 / 定时任务 / 任务板卡片用更严的档）。相应章节：§3.2 / §3.6 / §3.7 / §5.3 / §7 / §8 / §9。

---

## 0. 目标与验收标准

**一句话**：把「AI 审查」从别人的插件里拿回来自己做，把「记忆学习」「审批时间线 / 输入框提示」并进同一个插件，让"谁批的"成为事实而不是推测。

**单一实现（2026-11-03 追加约束）**：本插件的**全部能力都自己提供**，不依赖任何上游插件。
装好之后 `dsh-auto-review` / `（自用的）学习插件` / `（自用的）面板插件` / `dsh-approval-toast`
四行都可以从 profile 的 bundles 里删掉。任何"需要旧插件还在"的能力都算未完成——
这就是 diff/撤销被从"可选"提升为 P3.5 必备的原因。

| # | 验收标准 | 判定方式 |
|---|---|---|
| G1 | 每条审批记录都带**确定的归属**：`ai / memory / human / external / fallback` | 现场跑 10 条逐条对照，零错标 |
| G2 | AI 只能给 **allow / ask**，**永不 deny**；参数不可见 / 超时 / 模型抽风一律转人工 | 4 类语料各 2 例 |
| G3 | 记忆自动通过：人工批同一操作 3 次，第 4 次 ≤1s 自动放行，且**按会话隔离** | 现场连点 |
| G4 | 输入框上方提示：待人工 = 常驻黄卡；AI / 记忆通过 = 4 秒绿 / 蓝卡 | 截图比对 §5.1 |
| G5 | 审批页顶部有「设置」，可开关 AI 审查 / 记忆自动通过 / 输入框提示 | 三项各拨一次 |
| G6 | 用户列的 8 处 UI 问题逐条修掉 | §5.2 勾选 |
| G7 | 零新增常驻工具、零写入会话日志、审批链**永不被本插件阻断** | 代码审查 + 故障注入 |
| G11 | **单一实现**：删掉四个旧插件后，AI 审查 / 记忆 / 界面 / 提示 / 通知 / 台账 / diff / 撤销 **全部照常** | 删四行 → 重启 → 重跑 §4 清单 |
| G8 | 待人工审批时弹一条 toast，点击跳审批页；设置里可关，关掉后**一条都不弹** | 开关各拨一次 |
| G9 | 台账可导出 CSV / JSON，字段含归属、风险、理由、摘要，导出内容与页面一致 | 导出后核对行数 |
| G10 | 按 agent 分档：子代理 / 定时任务触发同等危险操作时，档位比主会话**更严**（不因无人值守而放宽） | 三类来源各造一例 |

**非目标**：不做跨会话记忆（硬约束）；不 fork moon / auto-review；不改 `node_modules`；不引新依赖。

---

## 1. 证据基线

完整取证过程见 `RESEARCH.md`。三条结论直接决定架构：

1. 旧 bridge 的「AI 通过 / 人工通过」是**推断**，不是事实：187 行记录里 `verdict` 字段存在数为 **0**，`source` 只表示"这行是谁存下来的"。
2. auto-review 的证据提取只索引 `tool/call`，PTC 折叠调用的 `callId:xxx:ptc:N` 永不命中 → 参数不可见；失败语义是 fail-closed **deny**（终局）。
3. 市面上没有「AI 层 + 记忆层 + 完整 UI」合一的插件；最好的拼图分散在 moon（学习 + UI）与 auto-review（链式 + 预算），且两者都抢 `approval/request`，无法共存。

---

## 2. 架构：一个插件、三层、一个 answerer

```
                  approval/request
                        │
      ┌─────────────────▼────────────────────────────────┐
      │ dsh-review-hub（唯一 answerer，prepend）        │
      │  L0 硬风险前置  删除/凭据/远程/系统/批量 ─────────┼──► next()（人工，不学习不计次）
      │  L1 策略表      per-tool: ai|memory|human        │
      │  L2 记忆层      指纹命中且人工已批 ≥3 次 ─────────┼──► allow（decidedBy=memory）
      │  L3 AI 层       ctx.llm 单次 JSON，allow|ask ─────┼──► allow（decidedBy=ai）
      │                 ask/超时/不可解析/熔断 ──────────┼──► next()
      │  L4 兜底        await next() ← 人工（human）       │
      │                 或别的 answerer 抢答（external）  │
      └─────────────────┬────────────────────────────────┘
                        │ 每次裁决写一行（归属=事实）
                        ▼
       store ──► /entries /stats /pending /diff /revert /config /health
                        │
       客户端：composer.dock（提示） + conversation.view（审批页 + 设置）
```

**铁律**

1. 绝不向会话日志 append 未知事件类型——本次会话就因此炸过一次：撤销指令投递的 user 消息缺 `id`，整份日志判损坏、侧栏消失。
2. 任何异常都必须 `return next()`，审批链永远不被阻断。
3. 只读会话日志，只写自己的 `~/.dsh/storages/review-hub/`。
4. 撤销 = 投递一条**带 `id: crypto.randomUUID()`** 的用户指令，绝不直接改文件。

---

## 3. 决策管线

### 3.1 L0 硬风险五类（静态，永不进 AI、不计数、不学习）

| 类 | 典型形态 |
|---|---|
| 删除类 | `rm` / `del` / `rmdir` / `unlink` / `git clean` / 清空覆写已有文件 |
| 凭据类 | 读写 `.credentials*` / `.npmrc` / 私钥 / token 字面量进命令 |
| 远程执行 | `curl … | sh` / `irm … | iex` / nc、ssh 到公网 |
| 系统级 | HKLM 注册表、`sc`、`Set-ExecutionPolicy`、`bcdedit`、停服务 |
| 批量破坏 | 通配符删除、`--force` 推远端、`rm -rf /` |

命中 → `next()`，记录 `riskLevel='high'` 与命中规则名（UI 显示命中原因）。**这是"AI 不能替你删东西"的结构性保证。**

### 3.2 L1 策略表（默认值）

```yaml
toolsPolicy:
  default: human
  overrides:
    ops_bash: ai
    bash: ai
    pwsh: ai
    write: memory
    edit: memory
    run_code: memory
    plugin_manager: human
```

`memory` = 只允许记忆层放行，AI 不介入（写类在 PTC 断线修好前走稳妥档）。

#### 按 agent 分档（byAgent）—— v2 新增

同一个工具，**谁来调用**决定档位。无人值守的来源只会收紧，永远不会放宽：

```yaml
agentPolicy:
  # 键 = 请求来源分类；值是"上限档"，与 toolsPolicy 取更严的一方
  default:    { ai: full,   memory: on }   # 主会话：按 toolsPolicy 原样
  subagent:   { ai: strict, memory: on }   # 子代理：AI 只放行 low 风险，medium/high 一律转人工
  scheduled:  { ai: strict, memory: on }   # 定时任务 / cron
  task_board: { ai: strict, memory: on }   # 任务板卡片
  unknown:    { ai: strict, memory: on }   # 认不出来源时按最严处理
```

- `full`：AI 可放行 low/medium；`strict`：只有 low 才放行，medium/high 转人工；`off`：该来源不用 AI。
- **硬风险五类对任何来源都不放宽**（子代理删库照样转人工）。
- 记忆层 `memory: on` 对无人值守来源尤其重要——它不依赖"有人在旁边点"，正是夜里定时任务不卡死的落点。
- 来源分类靠 `request.agent`（P0 待验证：如何可靠区分主会话 / 子代理 / 任务板卡）；**认不出来一律 `unknown` → strict**。

### 3.3 L2 记忆层

- 指纹 `sha1(tool + 0x00 + normalize(args) + 0x00 + cwd族)`；`normalize` 复用 bridge `summary.js` 的脱敏与键序稳定化，路径只保留末两级。
- **计数只来自人工放行**（`decidedBy='human'` 且 `allowed-once`）；AI / 记忆自己的放行绝不计数（防自我强化，照抄 moon 纪律）。
- 阈值 3：人工批 3 次 → 第 4 次命中即 allow，UI 显示「记忆通过 · 记忆 3/3 次」。
- **按会话隔离**：键 = `sessionId + 0x00 + fingerprint`；换会话从 0 开始。

### 3.4 L3 AI 层

证据全部来自可读会话日志（**PTC 感知**）：tool、argsSummary(≤240 脱敏)、justification、cwd、会话权限档、同指纹历史、硬风险命中 = false。

- **取参优先级**：`tool/ptc-dispatch-start`（`subCallId` 命中）→ `tool/call`（基 id）→ `request.reason` 文本解析。这一条直接修掉 auto-review 的盲区，不必等上游。
- **调用**：`ctx.llm` 单次（不派子代理），temperature 0，输出强约束 JSON：
  `{"decision":"allow|ask","risk":"low|medium|high","reason":"≤120字"}`
- **解析**：去 JSON 围栏、剥前后噪声；parse 失败 → **ask（不是 deny）**；`<tool_call…` 这类垃圾输出自动落到 ask。
- **决策里没有 deny**：AI 只能放行或交给人；要"拦住"的活交给 L0 确定性规则。
- **预算 / 熔断**：每轮 20 次；连续 3 次失败 → 本会话 AI 自动关闭并 UI 红字；单次超时 8s。
- **缓存**：同指纹同参数 hash 在 10 分钟内复用上次结论（省 token）。
- `ctx.llm` 不存在或不可用 → AI 层降级，记忆层与 UI 照常工作。

### 3.5 归属判定（本设计的关键产出）

`entry.decidedBy = 'ai' | 'memory' | 'human' | 'external' | 'fallback'`

| 分支 | 归属 | 依据 |
|---|---|---|
| 本插件自己放行 | `ai` / `memory` | 事实 |
| 交给 `next()` 且无人抢答 | `human` | `next()` 阻塞到人工点按后返回（现有 271690ms 的 `allowed-once` 是活证据） |
| `next()` 在 **<300ms** 内返回且非本插件决定 | `external` | 还有别的 answerer 在抢；UI 标注 + 告警 |
| 链返回 `unavailable` | `fallback` | reviewer 挂 / 超时 / 取消 |

**P4 之后 `external` 恒为 0，归属 100% 准确** —— 这就是 G1 的验收方式。

### 3.6 通知层（toast）—— v2 新增

- **触发**：只在「待人工」状态出现时弹一条，避免变成噪音源。AI 通过 / 记忆通过**不弹** toast（那是输入框上方提示卡的事）。
- **实现**：客户端 `Notification` API（GUI 打开时生效，不需要 shell、不需要第三方插件），点击通知 → 切到「审批」标签页并滚到该条。
- **去重**：同一 `callId` 只弹一次；同一会话 10 秒内最多 1 条（批量弹窗时合并成"还有 N 条待审批"）。
- **开关**：设置里 `toastEnabled`（默认开）。关掉后**一条都不弹**，且不再请求浏览器通知权限。
- **与 `dsh-approval-toast` 的关系**：它是 Windows 原生 toast，能力更强（缩到托盘也能弹），但**开关在它自己那边**。本插件不代管它：README 里写清"两者同开会弹两条，选一条即可"——想用原生 toast 就关掉本插件的 `toastEnabled`，两边的开关各管各的，不互相偷偷改配置。
- 权限失败（用户拒绝通知权限）→ 静默降级，不报错、不重试。

### 3.7 台账导出 —— v2 新增

- **路由**：`GET /export?session=<sid>&format=csv|json`，只读、带同源围栏；`format` 缺省 `csv`。
- **内容**：`ts, sessionId, toolName, outcome, decidedBy, riskLevel, riskRule, decisionMs, argsSummary, reason`（`argsSummary` 已脱敏；**不导出**任何凭据、不导出 diff 正文）。
- **范围**：默认导出**当前会话**；设置面板里可选"全部会话"（需要二次确认，因为跨会话导出＝把别的会话的审批摘要写进一个文件）。
- **入口**：设置面板里的「导出台账（CSV / JSON）」两个按钮，客户端用 blobby 下载，不经宿主二次落盘。
- **编码**：CSV 带 UTF-8 BOM + CRLF（Excel 打开中文不乱码）；字段含逗号/引号按 RFC4180 转义。

---

## 4. 数据与存储

`~/.dsh/storages/review-hub/`

| 文件 | 内容 |
|---|---|
| `entries.json` | `{version, sessions:{sid:[row ≤200]}, cleared:{sid:ts}}`；row 带 `id/ts/sessionId/toolName/callId/outcome/decidedBy/riskLevel/riskRule/reason/argsSummary/argsTruncated/decisionMs/hasSnapshot` |
| `memory.json` | `{version, entries:{"<sid>\0<fp>":{toolName,summary,count,firstTs,lastTs,calls[]}}}` |
| `settings.json` | 见 §7 |
| `snapshots/<sid>/index.json` | 写前快照：64 条 / 会话，256KB / 条 |

**清空语义改为按会话**：`cleared[sid] = ts` 单会话水位线，`query / stats / reconcile` 一律跳过 `ts ≤ cleared[sid]`；**删掉** 2026-11-03 临时加的全局 `clearedAll`。

---

## 5. 界面规格

### 5.1 输入框上方提示（`conversation.composer.dock`，order -50）

| 状态 | 外观 | 时长 |
|---|---|---|
| **待人工** | 黄卡：`⏱ <tool> 等待人工审批：<摘要>` / 次行 `人工审批中 HH:MM:SS` / 右上 ✕（本次会话不再弹这张卡） | 常驻到裁决 |
| **AI 通过** | 绿卡：`✓ AI 通过 · <风险> · <tool> · <摘要>` | 4s 淡出 |
| **记忆通过** | 蓝卡：`✓ 记忆通过 · 记忆 3/3 次 · <tool> · <摘要>` | 4s 淡出 |
| **AI 转人工** | 灰卡：`AI 拿不准，已转人工`（紧跟黄卡出现） | 2s |
| **外部插件决定** | 灰卡：`由外部插件裁决`（P4 后不应出现） | 2s |

数据：新增只读 `GET /pending?session=`（宿主半身维护 pending Map，answerer 进入登记、裁决删除），客户端 1s 轮询；与原「自动放行绿条」**合并成一个组件**，不再并排两条。开关 `composerHint`。

**与原生审批面板的关系（P0 已实测）**：宿主的人工审批面板由 `dsh-client-ui-approval` 注册在 `conversation.composer` 席位（按 `pendingInteraction` 选中），本插件占的是 `conversation.composer.dock`，**两个席位不冲突**。因此「待人工」不再在输入框上方重复画黄卡（原生面板已经在那儿了），改为 **toast + 标签角标**；dock 只负责 AI 通过 / 记忆通过 / AI 转人工 的 4 秒提示——与你说的"人工自己会弹"一致。想保留待人工黄卡时用 `pendingCard: true`（默认关）。

### 5.2 用户列的 8 条，逐条落法

| # | 问题 | 根因 | 做法 |
|---|---|---|---|
| 1 | 审批发生时输入框上方没提示 | 只有"自动放行绿条"，缺待人工 / 记忆两态 | §5.1 三态卡 |
| 2 | `1/3 次 · 满 3 次自动放行` 啰嗦 | 文案 | 统一 **`记忆 1/3 次`**（chip：`人工通过 · 记忆 1/3 次`） |
| 3 | 搜索图标 `⌕` 认不出 | 图标语义弱 | 换文字按钮 **`查找`**（与 `记忆操作 N 条` / `设置` 同风格同高） |
| 4 | 日历无圆角；再点日历按钮会"闪一下" | `datetime-local` 每次 render 被重建（条件子树 + 变 key）→ 原生弹层销毁重建 | ① `border-radius:8px` + 统一内边距；② 筛选行**常驻挂载**、用 CSS 隐藏；③ 按钮自管开关：首次 `showPicker()`、再次 `blur()`，不 remount；`stopPropagation` 防外层折叠 |
| 5 | 「清空已学」 | 命名 | 改 **「清空记忆」**，同样 **停手 6 秒作废** |
| 6 | 「清空历史」跨会话 | 现在 `all:true` 是全局 | 改**只清当前会话**；删全局水位线 |
| 7 | 设置里"已关闭：本插件不会删除任何记录" | 文案 | **删掉** |
| 8 | 标签颜色混乱 | 归属不准 | 按 `decidedBy` 上色：人工黄 / 记忆蓝 / AI 绿 / 拒绝红 / 取消·不可用灰 |

### 5.3 审批页（`conversation.view`，`label` 保持纯字符串 `审批`）

```
共 18 条 · 放行 13 · 拒绝 5 · 取消 0 · 不可用 0      [查找] [记忆操作 3 条] [设置]
────────────────────────────────────────────────────────────
[查找] 展开行：<文本输入> [起] 2026-11-03T00:00 [止] … [筛出 5 条] [清除]
────────────────────────────────────────────────────────────
✓ ops_bash [AI 通过]                     11-03 21:21:30  [改动]
   escalate sandbox to danger-full-access: …
✓ edit     [人工通过 · 记忆 2/3 次]       11-03 20:44:16  [改动]
```

「设置」为页内面板（宿主设置页的 `plugins.bundle.config` 仍保留低级项）：

```
AI 审查            [开]   模型 / 超时 / 预算（折叠）
记忆自动通过        [开]   阈值 3 次
输入框上方提示      [开]
待人工时弹通知      [开]   ← toast；与 dsh-approval-toast 二选一
────────────────────────────
台账
  导出当前会话  [CSV] [JSON]
  导出全部会话  [CSV] [JSON]   ← 需二次确认
────────────────────────────
危险操作
  清空历史（仅当前会话）   ← 红字，连点 3 次，停手 6 秒作废
  清空记忆（仅当前会话）   ← 红字，停手 6 秒作废
```

---

## 6. 目录结构

```
plugin/dsh-review-hub/
├── PLAN.md  RESEARCH.md  README.md
├── package.json  cordis.patch.yml
├── src/
│   ├── index.js      装配：answerer / 路由 / 快照钩子 / 配置
│   ├── policy.js     L0 硬风险五类 + L1 策略表
│   ├── memory.js     指纹、计数、阈值、会话隔离
│   ├── review.js     L3：证据 + ctx.llm 单次 JSON + 预算/熔断/缓存
│   ├── evidence.js   PTC 感知取参（ptc-dispatch-start → tool/call → reason）
│   ├── store.js      entries/memory/settings 原子写 + 水位线
│   ├── snapshot.js   写前快照（移植 bridge）
│   ├── diff.js       LCS unified diff（移植 bridge）
│   ├── routes.js     /entries /stats /health /pending /config /clear /diff /revert /export
│   ├── agentPolicy.js 按 agent 分档（subagent / scheduled / task_board / unknown）
│   ├── export.js     台账 CSV / JSON 序列化（BOM、RFC4180 转义）
│   └── client.js     composer dock + 审批页 + 设置面板 + toast
└── test/             无框架套件（照 bridge 的 runner 形态）
```

---

## 7. 配置默认值

| 键 | 默认 | 说明 |
|---|---|---|
| `aiEnabled` | true | AI 审查总开关（页面「设置」可改） |
| `memoryEnabled` | true | 记忆自动通过 |
| `composerHint` | true | 输入框上方提示 |
| `threshold` | 3 | 记忆阈值 1–5 |
| `aiFailurePolicy` | `'ask'` | 固定，不提供 deny |
| `reviewTimeoutMs` | 8000 | 单次超时 |
| `aiBudgetPerTurn` | 20 | 每轮上限 |
| `aiBreakerFails` | 3 | 连续失败熔断 |
| `aiCacheTtlMs` | 600000 | 同指纹缓存 |
| `reviewerModel` | 空 = 会话默认 | 可钉稳定车道 |
| `clearEnabled` | false | 危险区开关 |
| `maxEntriesPerSession` | 200 | 环形上限 |
| `pollMs` | 1000 | 客户端轮询 |
| `toastEnabled` | true | 待人工时弹 toast（设置里可关） |
| `toastQuietMs` | 10000 | 同会话 toast 合并窗口 |
| `agentPolicy.subagent` | `strict` | 子代理来源的 AI 上限档 |
| `agentPolicy.scheduled` | `strict` | 定时任务 / cron |
| `agentPolicy.task_board` | `strict` | 任务板卡片 |
| `agentPolicy.unknown` | `strict` | 认不出来源时按最严 |
| `exportScope` | `session` | 台账默认导出范围（session / all） |

---

## 8. 阶段与验收门

### P0 · 探针（先拿事实，0.5 天）

1. **answerer 契约**：不 claim 时 `next()` 是否阻塞到人工点按？人工结果是否经它返回？
2. **PTC 证据**：制造一次 `callId:xxx:ptc:1` 的审批，确认能从 `tool/ptc-dispatch-start` 取到内层参数。
3. **归属**：关掉 auto-review 后，确认 `external` 恒为 0。
4. **dock 渲染**：`conversation.composer.dock` 是否允许多个注册共存（决定是否必须先卸旧绿条）。
5. **agent 分类**：`request.agent` 上有没有可靠字段区分主会话 / 子代理 / 任务板卡片 / 定时任务（决定 §3.2 的 byAgent 怎么落地；认不出来就全归 `unknown`）。
6. **通知权限**：桌面端 Web GUI 里 `Notification` 是否可用、是否需要用户手势触发（决定 toast 的降级策略）。

> **P0 结论（2026-11-03，源码级已验 1/2/4；3/5/6 待运行时）**
>
> 1. **answerer 契约 ✅**：`dsh-user-approval` 的 `decide()` = `ctx.waterfall(scopeTarget(agent, agent), "approval/request", req, () => 'unavailable')`。瀑布末端如果没人应答就返回 `unavailable`（以拒绝方式关闭），**服务本身从不弹窗**；人工面板是**客户端侧的远程 answerer**（`dsh-client-ui-approval/lib/client.js:355` → `ctx.remote.$on("approval/request", (req,next) => answerApproval(...))`，这一事件在 `API_REMOTE_FORWARDED_EVENTS` 里以 `waterfall` 模式转发到浏览器）。→ **`await next()` 确实会等到人工点按并拿回结果**；我们的 hub 必须在"不接管"时无条件 `return next()`，否则原生面板收不到请求、请求会以 `unavailable` 关闭。
> 2. **PTC 证据 ✅（已有旁证）**：`tool/ptc-dispatch-start` 携带内层 `subCallId/name/arguments`，bridge 的 `summary.js` 已在用；P1 落地时按此实现取参，P2 再补一次现场验收。
> 3. **归属** ⏳ 需装插件后实测（关掉 auto-review 看 `external` 是否为 0）。
> 4. **dock 多注册 ✅**：原生面板在 `conversation.composer`，我们在 `conversation.composer.dock`，**不同席位、天然共存**——不必先卸旧绿条。附带发现：客户端可用 `pendingInteraction`（`PendingApproval` 实例）判断"原生面板正在显示"，用来避免重复提示。
> 5. **agent 分类** ⏳ 待验：`req.agent` 是 live agent 对象（含 `session`），需要确认子代理 / 任务板卡片在上面有什么可区分字段；认不出来一律 `unknown → strict`。
> 6. **通知权限** ⏳ 待验：桌面端 Web GUI 的 `Notification` 是否可用、是否需要用户手势。
>
> 另有一条重要提醒（来自 `dsh-user-approval` README）：**"同级监听器的顺序不是策略优先级机制"**，所以归属判定绝不能靠链上的位置，只能靠"谁真的做了决定"——与 §3.5 一致。

### P1 · 宿主内核（记忆 + 归属 + 存储，无 AI）

交付：answerer / policy / memory / store / routes + 单元测试。
验收：关掉 auto-review 与 learn，人工批同一 `ops_bash` 3 次 → 第 4 次 ≤1s 放行，chip 显示「记忆通过 · 记忆 3/3 次」；`decidedBy` 三个值各出现一次且正确。

### P2 · AI 层 ✅ 已完成（2026-11-03，46 用例全绿）

交付：`review.js` + `evidence.js` + `agentPolicy.js`（按来源收紧档位）。

落地细节（与计划的差异都记在这里）：

- **只有 allow / ask 两个决策**：模型若回 `deny`，`parseVerdict` 判为无效（`undefined`）→ 转人工，而不是照办。
- **预算按 60 秒滚动窗口**而非"一轮"（宿主没有稳定的 turn 信号给插件）；字段仍叫 `aiBudgetPerTurn`，文档标注每分钟口径。
- **熔断 5 分钟**（`BREAKER_OPEN_MS`），期间一律转人工；`reviewer.reset(sessionId)` 手动复位，`/health` 暴露 `breakerState`。
- **缓存键 = 会话 + 指纹**，TTL `aiCacheTtlMs`，命中不调模型。
- **模型适配（2026-11-04 装机后校正）**：`ctx.llm` **必须用 `ctx.inject(['llm'], …)` 取**——直接读 `ctx.llm` 会因未声明注入而抛错，被 try/catch 吞掉后表现为 `aiSource='unavailable', aiReason='no llm service'`（现场实测）。
- 真实调用形状（抄自 dsh-auto-review 的 inline reviewer）：`llm.stream({ provider, model, system, messages:[{role:'user',content:[{type:'text',text}]}], temperature:0, signal })`，**必须带 provider/model**；chunk 是 block 事件，终止块为 `{type:'finish', reason:{kind:'stop'|'error'|'aborted'}}`。
- **路由来源**：`settings.reviewerModel`（写成 `provider/model`）优先；否则从会话事件里倒着找 `request/header` 的 `data.header.config.{provider, model}`（即该轮实际用的路由）。
- **层级顺序实测**：记忆层在 AI 层之前——同一操作连批 3 次后第 4 次是"记忆通过"，根本不会送到 reviewer。
验收语料：① 无害命令 ② 危险形态 + 合理 justification ③ 危险形态 + 无理由 ④ PTC 折叠调用。预期：①② 放行、③ 转人工、④ 能读到参数并给出结论（不是"参数不可见"）；另加 3 条垃圾输出（`<tool_call…`、截断 JSON、空响应）→ 全部转人工，**无一 deny**。

### P3 · 客户端 ✅ 已完成（2026-11-03，52 用例全绿）

交付：composer 三态卡 + 审批页 + 页内设置 + toast（`toastEnabled` 开关）+ 台账导出（`export.js`）。

落地要点：

- **composer dock 自己轮询**（不带 session 参数），因为 dock 席位拿不到 sessionId；它同时负责 toast 去重与「刚被裁决」的监听，审批页只管列表与统计。
- **「待人工」默认不画黄卡**（`pendingCard: false`）：原生面板已经在输入框里弹了；dock 只做 AI 通过 / 记忆通过 的 4 秒提示 + toast。
- **日期筛选行常驻挂载、用 `hidden` 隐藏**：`datetime-local` 一旦被条件渲染重建，原生弹层就会销毁重建——这就是"再点日历按钮闪一下"的根因；现在元素不重建，并给了 `border-radius: 8px`。
- **「查找」是文字按钮**，`⌕` 已从代码与文案中消失（有测试断言）。
- **设置面板在页内**（工具栏第三个按钮）：四个开关 + 导出台账（CSV/JSON、可选全部会话）+ 红字危险区；「清空历史」三击、「清空记忆」二击，都停手 6 秒作废，且服务端对 `/clear` 另有 `clearEnabled` 硬拦。
- **台账导出走 blob 下载**，不经宿主二次落盘。
- **P3.5 待做（单一实现必备）**：diff 查看 / 一键撤销。bridge 的 `snapshot.js`（写前快照）与 `diff.js`（LCS unified diff）可直接移植，另需 `/diff` `/revert` 两条路由与行内展开面板。
验收：§5.2 八条逐条勾选；顶部三按钮（查找 / 记忆操作 / 设置）布局与截图一致；日历开关不闪；待人工时 toast 弹出且点击能跳；关开关后一条不弹；导出 CSV 用 Excel 打开中文不乱码。

### P3.5 · diff 与撤销（单一实现的最后一块）✅ 已完成（2026-11-03，63 用例全绿）

- **移植**：bridge 的 `snapshot.js`（写前快照）与 `diff.js`（LCS unified diff）搬进本插件，只改了两处：`callIdMatches` 改从 `evidence.js` 引、日志前缀与存储根改成本插件自己的。
- **钩子**：`tools/pre-execute` 上登记快照捕获（prepend），**任何分支都 `return next()`**——捕获失败只意味着"这行没有 diff"，绝不是拦住工具。
- **路由**：`/diff`（GET，四种降级都回 200 + reason：no-snapshot / binary / too-large / no-after）、`/revert`（POST，把指令投给该会话的 agent）；`/entries` 每行补 `hasSnapshot`。
- **客户端**：有快照的行出现「改动」按钮 → 行内展开 unified diff（双行号、add/del 着色、hunk 头）→ 「撤销此改动」。
- **血泪规则**：撤销投递的消息**必须带 `id`**（兜底形状用 `crypto.randomUUID()`）。旧 bridge 的兜底漏了 id，让整份会话日志判损坏、侧栏里那个会话直接消失。这条有专门的测试断言（`p3: revert：投递的用户消息必须带 id`）。

### P3.6 · 装机现场验收 ✅（2026-11-04，真实宿主 0.2.1-rc.5）

重启后按 §4 清单跑了一遍，四条链路全部拿到实证（`~/.dsh/storages/review-hub/entries.json`）：

| 时间 | 操作 | decidedBy | 耗时 | aiSource | risk | 说明 |
|---|---|---|---|---|---|---|
| 16:45:17 | pwsh 只读列目录 | **ai** | 3.6s | ai | low | 模型判「read-only, no writes, scoped path」→ 直接放行，**没弹人工** |
| 16:44:19 | pwsh echo 升级 full-access | human | 27.5s | ai | medium | 模型判「echo 不需要 full-access，超出范围」→ **ask 而不是 deny**，交人工 |
| 16:30:37 | pwsh echo（llm 未接通时） | human | 6.0s | unavailable | unknown | 现场抓到 `no llm service`，据此修了注入方式 |
| 16:29:35 | write 探针文件 | human | 6.5s | — | unknown | 记忆计数 +1 |

外加：PTC 子调用（`call_...:ptc:1` / `:ptc:2`）的 `argsSummary` 都被解析出来；记忆按会话隔离计数；`external` 全程为 0。

### P4 · 切换与退役

profile：`bundles` 加 `dsh-review-hub`，同时移除 **四行**：`dsh-auto-review`、`（自用的）学习插件`、`dsh-（自用的）面板插件`、`dsh-approval-toast`（依赖保留，随时回滚）。
不再"保留 toast 现装"——单一实现后本插件自带通知，两者同开会弹两条。
验收：真实审批全链路走一遍；`/entries` 里 `external` = 0；`/health` 显示 answerer 已注册、AI 层可用。

### P5 · 文档与巡检

README（含排障：AI 不可用 / 熔断 / 为什么转人工）、`RESEARCH.md` 落盘、更新每日巡检卡的插件清单与版本基线。

---

## 9. 测试计划（无框架，照 bridge 的 `test/run.mjs` 形态）

| 套件 | 用例要点 |
|---|---|
| `policy` | 五类硬风险各 3 例命中 / 不误伤；策略表 ai / memory / human 分派 |
| `memory` | 指纹稳定性（同义参数归一）、阈值、**只认人工计数**、会话隔离、清空后从 0 |
| `review` | 4 类语料 + 3 类垃圾输出 → ask；超时 → ask；熔断后不再调用；缓存命中不重复计费 |
| `evidence` | ptc-dispatch-start 优先、tool/call 兜底、reason 兜底、脱敏、240 截断 |
| `store` | 原子写、环形淘汰、会话水位线防回填、settings clamp |
| `routes` | 信任围栏（回环 + 同源）、方法门、`/clear` 需开关、`/diff` 四种降级 |
| `snapshot + diff` | 移植 bridge p3 的 30+ 例 |
| `agentPolicy` | 主会话 full / 子代理 strict / 未知 → strict；与 toolsPolicy 取更严；硬风险对任何来源都不放宽 |
| `export` | CSV 的 BOM 与 CRLF、逗号引号转义、字段顺序稳定、归属字段正确、不含凭据 |
| `notify` | 同 callId 去重、10 秒合并、`toastEnabled=false` 时零调用、权限拒绝时静默 |
| `client.smoke` | loader id、四席位、label 纯字符串、zh/en 键数一致、样式注入一次 |

目标 ≥110 例；P4 前全绿。

---

## 10. 迁移与回滚

- **安装**：link 插件 —— 改 profile `package.json` 的 deps + bundles → `pnpm install --lockfile-only` → 建 junction。**绝不跑全量 install**（会清掉 better-sqlite3 / cpu-features 的原生构建）。
- **兼容声明**：`engines.dsh` 用**范围式** `>=0.2.1-rc.1 <0.3.0`，不写枚举（nightly 每次升级都会把枚举型插件打下线）。
- **回滚**：四行旧插件加回 bundles、删掉 hub 一行、重启；数据目录互不相干，旧 `approvals.json` / allowlist / toast 配置都保留。
- **单一实现校验**：装好后 `pnpm ls` 里不应再出现对这四者的运行时引用；`/health` 的 `counters.external` 必须恒为 0（出现即说明还有别的 answerer 在抢）。

---

## 11. 风险与应对

| 风险 | 应对 |
|---|---|
| `ctx.llm` 不可用 / 车道排队 | AI 降级为 memory + human，UI 红字提示；可钉独立 `reviewerModel` |
| PTC 参数重建失效（上游改事件名） | 三路兜底 + P0 探针；失效时 AI 一律 ask（不影响安全） |
| 与旧 auto-review 抢答（P4 前同装） | `external` 归属检测 + 日志告警；P4 才切换 |
| 我方 answerer 抛异常 | 全员 try/catch，兜底 `return next()`；故障注入测试覆盖 |
| 记忆被 AI 结论污染（自我强化） | 只认 `decidedBy='human'` 计数；AI / 记忆放行不计数 |
| 清空误操作 | 设置内开关默认关 + 三击 + 6 秒作废；服务端也校验开关 |
| 宿主 rc 升级 | 范围式 engines；每 rc 手测一次 `/health` |

---

## 12. 已按以下假设推进（不同意一句话推翻）

1. 插件名 / 目录：`dsh-review-hub` / `D:\Work\Agent\plugin\dsh-review-hub`。
2. **AI 无否决权**（只能 allow / ask），硬风险由静态规则兜底；若要让 AI 能直接 reject，需加 `aiCanReject` 并独立验收。
3. 记忆阈值沿用 3、只认人工批准、**按会话隔离**（跨会话永不做）。
4. 旧三插件在 P4 一次性退役；P4 前 hub 装好但 AI 仍由 auto-review 掌管，切换点由用户点头。
5. 输入框上方提示**合并原绿条**，不再并排两条。

---

## 13. 执行顺序

1. 建目录，落盘 `PLAN.md`（本文）+ `RESEARCH.md`（调研与诊断）。
2. P0 只读探针脚本，结论写回 §8。
3. 骨架（package.json / cordis.patch.yml / index.js 装配 + `/health`），先确认"宿主能挂载、answerer 能注册"。
4. 按 P1 → P3 推进，每阶段停下验收，再进下一阶段。
