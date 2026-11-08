# dsh-review-hub 调研与诊断 (RESEARCH)

> 采集时间：2026-11-03，本机 DSH Desktop 0.2.1-rc.5（nightly）。
> 每条结论都标了取证方式；带 ⚠️ 的是尚未正面验证的推断。
> 与 `PLAN.md` 的分工：PLAN 是设计与阶段，本文是"为什么这么设计"的证据。

---

## 1. 旧栈的三家现状

| 插件 | 版本 | 在链上的角色 |
|---|---|---|
| `dsh-auto-review` | 0.15.0 | `approval/request` 链首 answerer（prepend），按 `toolsPolicy` 决定接管或放过 |
| `（自用的）学习插件` | 本仓 link | 链首 answerer，指纹命中且人工批够次数 → 直接 allow |
| `（自用的）面板插件` | 本仓 link | 链首**第二个** observer answerer（只记录，永远 `next()`）+ composer 绿条 + 「审批」标签页 |

三者都抢同一条瀑布，顺序靠"谁 prepend 得晚谁在头"决出——这就是为什么 bridge 要注册两次。

---

## 2. auto-review 的实现（读 `~/.dsh/profiles/desktop/node_modules/dsh-auto-review/lib/index.js`）

| 环节 | 实现 | 行号 |
|---|---|---|
| 挂载 | `ctx.on("approval/request", (req, next) => runtime.answer(req, next), { prepend: true })` | 8186 |
| 决策范围 | `config.toolsPolicy = { default, overrides }`，只有 `ai` 的才接管，其余直接放过 | 372 |
| 证据提取 | `sanitizedArgumentsText()` 只索引会话日志里的 `tool/call` 事件 | — |
| reviewer 后端 | `reviewerBackend: 'agent' | 'phocinae'`；agent 后端 `reviewerProvider: 'fork'`（派只读子代理，工具白名单 `reviewerTools`）；phocinae 是本地 150M 分类器 | 366 / 384 / 398 |
| 也可走 llm | `for await (const chunk of llm.stream({ … toolFilter … }))` —— 与会话同一路由 | 7127 |
| 失败语义 | fail-**closed**：reviewer 不可用 → 请求直接 `rejected`（终局，不给人工机会） | 全文 22 处提及 |
| 超时 | `reviewerTimeoutMs: 60000` | 397 |
| 审计 | 裁决写成 `autoReview/*` 事件进会话日志，面板读日志投影 → 轮次边界才刷新 | — |
| 学习 | 无指纹库（同指纹结论有短期缓存，但不是"人工批过 N 次就自动"） | — |

**五个痛点**：①PTC 折叠调用参数看不见（`callId:xxx:ptc:N` 不命中 `tool/call`）②deny 是终局 ③面板慢 ④不学习 ⑤归属不可知（见 §3）。

---

## 3. 归属错标的取证（"AI 放行显示成人工"）

### 3.1 数据

`~/.dsh/storages/（自用的）面板插件/approvals.json`，187 行 / 4 个会话：

| `source` | `outcome` | 条数 | 客户端标签 |
|---|---|---|---|
| `ai` | `allowed-once` | 161 | 「AI 通过」 |
| `ai` | `rejected` | 13 | 「AI 拒绝」 |
| `answerer` | `allowed-once` | 13 | **「人工通过」** |

- 11-03 00:00 之后 38 行：`ai` 25 / `answerer` 13。
- 分会话：`session-cbac0564 (装插件(1))` 96 行（85 ai / 11 answerer）、`session-a48afe51 (装插件)` 47（45 / 2）、`session-e27f1e94` 37（全 ai）、`session-c2168915` 7（全 ai）。
- **187 行里 `verdict` 字段存在数 = 0。**

### 3.2 根因

1. 上游 `autoReview/verdict` 事件在本宿主**一条都没落地**：宿主的持久化读路径拒绝未知/未标记事件，rc.5 把 `autoReview/*` 按不可忽略丢弃。插件从未看见过审查结论。
2. 于是 `src/client.js` 的 `chipOf()` 只能猜：`entry.source === 'ai'` → 「AI 通过」，否则 → 「人工通过」。
3. 而 `source` 的语义是**这行是谁存下来的**：
   - `answerer`：bridge 的 observer（它在链首 `await next()`）亲眼看到这次请求；
   - `ai`：observer 没看到，由 `reconcile` 从会话日志补建，代码里直接写死 `'ai'`。
4. 因此**两个方向都会错**：AI 抢答但 observer 看见了 → 「人工通过」（用户观察到的现象）；人工批但 observer 当时没挂上 → 「AI 通过」。

### 3.3 结论

不是 auto-review 单个插件的问题，是**"归属靠推断"这个架构缺陷**。可靠修法只有一条：让插件自己成为裁决者，把 `decidedBy` 当场写成事实。

### 3.4 复现命令

```js
// 在 run_code 里执行（只读）
const doc = JSON.parse(await (await import('node:fs/promises'))
  .readFile('C:/Users/FMR/.dsh/storages/（自用的）面板插件/approvals.json', 'utf8'));
const rows = Object.values(doc.sessions).flat();
console.log(rows.length, rows.filter(r => r.verdict).length);   // 187 0
console.log(rows.map(r => r.source + '/' + r.outcome).reduce((a, k) => (a[k] = (a[k] || 0) + 1, a), {}));
```

---

## 4. 同类审批插件调研

### 4.1 版本核对（`registry.npmjs.org/<pkg>/latest`，2026-11-03）

| 包 | 最新版 | 运行时依赖 | 一句话 |
|---|---|---|---|
| `dsh-auto-review` | 0.15.0 | 2 | 第二模型 AI 审查（§2） |
| `dsh-perm-gate` | 5.4.4 | 3 | 确定性权限门（P0–P4 阶梯） |
| `dsh-approval-gate-safe` | 0.2.4 | 0 | moon 原版 0.5.2 的兼容加固 fork |
| ```goodandready/dsh-approval-gate` | 0.1.31 | 0 | 纯规则命令安全门 |
| `dsh-approval-toast` | 1.0.3 | 0 | Windows toast 里直接批 |
| `dsh-approval-ledger` | 1.2.2 | 0 | 批量审批 + 风险门 + 台账 |
| `dsh-approval-hotkeys` | 0.2.0 | 0 | Enter 确认 / Esc 取消 |
| @aiwayds/dsh-approval-policy | 0.2.1 | 0 | 无人值守：子代理 / cron 有界答复 |

> 刷新方式：把上表包名填进同一个循环，`fetch('https://registry.npmjs.org/' + p.replace('/','%2f') + '/latest')`。

### 4.2 逐个拆解：机制与可借鉴点

**moon09300731/dsh-approval-gate（原创，GitHub，v0.5.2，2026-08-20 停更，110★）**

- 机制：Flash 模型判 `SAFE` / `RISKY:类别`；五类硬风险（删除 / 凭据 / 远程 / 系统 / 批量）**永远转人工、永不学习、不计数**。
- **确认制学习**：同一操作被人工确认 N-1 次后自动放行；规则带操作指纹；措辞变了用"语义同类验证"再判。
- UI（用户最爱的部分）：「审批」标签页 = 放行时间线；自动放行时输入框上方绿条；**文件 unified diff 查看 + 一键撤销**；会话级快照管理。
- 可借鉴：整套"学习 + UI"的产品形态；硬风险白名单式豁免的纪律；`allowlist.json` 热载即时生效。
- 不借鉴：它是**拦截式门**（自己就是审批链的全部），没有"分层 + 永不阻断"的概念；Flash 绑定 Google 生态；对 rc.5 无兼容验证。

**dsh-approval-gate-safe（npm 0.2.4，70 dl/wk）** —— 上者的兼容加固 fork（README 自述"基于 0.5.2"），修了 0.1.2-rc.1 时代的 API、路由鉴权、Windows/PowerShell 词表。可借鉴它的**命令词表**（比原版宽），不借鉴其分发形态（仍是拦截式）。

**@goodandready/dsh-approval-gate（npm 0.1.31）** —— 纯 host 侧规则门：认得出的危险直接拦，**认不出的发给原生审批弹窗**。可借鉴的就是这条纪律：「看不懂就交给人」，也正是我们对 AI 层的核心约束。

**dsh-perm-gate（npm 5.4.4，品类下载第一）** —— P0 硬拒绝 → P1 会话级授权 → P2 静态规则 allow/deny → P3 可选 LLM 语义分类 → P4 转人工。LLM 只是可选层，绝大多数命令在 P0–P2 就判掉。可借鉴：**确定性优先的分层**、规则测试面板（输入工具名 + 命令，看完整链裁决，纯只读）、以及"perm-gate 判规则，判不出来才轮到 AI/人工"的分工。

**@aiwayds/dsh-approval-policy（npm 0.2.1）** —— 为子代理 / 定时任务 / cron 的审批请求给**有界答复**，解决"半夜定时任务卡在等人审批"。可借鉴：按 **agent 身份**分档（子代理的请求给更保守的策略）。列进 P2 之后的增强项。

**dsh-approval-toast（1.0.3）** —— Windows 原生 toast，通知里直接批。**与本插件互补，保留现装**：本插件负责"该不该打扰你"，toast 负责"打扰到你手上"。

**dsh-approval-ledger（1.2.2）** —— 批量审批 + 风险门 + 可导出的审计台账。可借鉴台账导出（P5 可选）。

**dsh-approval-hotkeys（0.2.0）** —— Enter 确认 / Esc 取消。原生审批弹窗不在我们手里，接管成本高，默认不做。

**AskTheWay/dsh-jev-interceptor** —— "毫秒级 System-1 判断每个工具调用"（静态规则前置思路）。参考意义大于集成意义：我们的 L0 硬风险层就是它那个位置的确定性版本。

### 4.3 结论

市场**没有**「AI 层 + 记忆层 + 完整 UI」合一的插件。最好的拼图分散在：

```
moon       → 学习循环 + 时间线/diff/绿条  （但它是拦截式，且停更）
auto-review→ 链式分层 + 预算/熔断 + llm 接法 （但 deny 终局、参数盲、无学习）
perm-gate  → 确定性优先的阶梯           （但无 UI、无学习）
```

三者都抢 `approval/request`，**无法共存**。要同时拿到"归属准确 + 不抢答 + 参数可见"，只能自建唯一 answerer —— 这就是本插件存在的理由。

---

## 5. 取 / 舍总表

| 来源 | 取 | 舍 |
|---|---|---|
| moon | 确认制学习（N-1）、硬风险永不学习、时间线 + diff + 撤销、输入框上方提示 | 拦截式架构、Flash 依赖、停更代码 |
| gate-safe | Windows/PowerShell 命令词表 | 拦截式分发、弱兼容声明 |
| goodandready | "看不懂就交给人" | 无学习、无 UI |
| perm-gate | P0–P4 分层、规则测试面板 | 与 UI 无关的重配置 |
| auto-review | `toolsPolicy` 分档、每轮预算、熔断、`ctx.llm` 接法 | fail-closed deny、fork 子代理、日志即状态 |
| toast | ——（直接复用现装插件） | —— |
| ledger / hotkeys / policy | 台账导出 / 键盘语义 / 按 agent 分档（均为 P5 候选） | —— |

---

## 6. P0 探针结果

| # | 项 | 状态 | 结论 |
|---|---|---|---|
| 1 | answerer 契约 | ✅ 源码级已验 | `ApprovalService.decide()` = `ctx.waterfall(scopeTarget(agent, agent), "approval/request", req, () => 'unavailable')`；**服务从不提示人类**，人工面板是**客户端侧远程 answerer**：`dsh-client-ui-approval/lib/client.js:355` → `ctx.remote.$on("approval/request", (req, next) => answerApproval(...))`，该事件在 `dsh-api-remotes/lib/types/remote-events.js:18` 以 `waterfall` 模式转发到浏览器。→ `await next()` 就是"等人工点按"，结果原路返回。**不接管时必须 `return next()`，否则原生面板收不到请求、请求以 `unavailable` 关闭。** |
| 2 | PTC 证据 | ✅ 已有旁证 | `tool/ptc-dispatch-start` 携带内层 `subCallId / name / arguments`；bridge `summary.js` 已在用。P1 按其实现取参，P2 再补一次现场验收。 |
| 3 | 归属 | ⏳ 待运行时 | 需装上插件、关掉 auto-review 后看 `external` 是否为 0。骨架已按 §3.5 实现计时归属，冒烟通过（human 406ms / external 0ms / 链路抛错→fallback）。 |
| 4 | dock 多注册 | ✅ 源码级已验 | 原生面板占 `conversation.composer`（`dsh-client-ui-approval` 用 `select: pendingInteraction instanceof PendingApproval`），我们占 `conversation.composer.dock`——**不同席位，天然共存**，不必先卸旧绿条。附带：客户端可用 `pendingInteraction` 判断"原生面板正在显示"，避免重复提示。 |
| 5 | agent 分类 | ⏳ 待验 | `req.agent` 是 live agent 对象；子代理 / 任务板卡片的可区分字段尚未确认，认不出来归 `unknown → strict`。 |
| 6 | 通知权限 | ⏳ 待验 | 桌面端 Web GUI 的 `Notification` 可用性与手势要求。 |
| 7 | `autoReview/*` 落库 | ✅ 已验 | 187 行记录 `verdict` 存在数 = 0，与本机日志一致：未标记事件不进持久化读路径。 |

### 结构性的额外发现

`dsh-user-approval/README.zh.md` 原文：**"同级监听器的顺序不是策略优先级机制"**。所以归属判定不能依赖链上位置（旧 bridge 正是这么错的），只能靠"谁真的做了决定"——与 PLAN §3.5 一致。

另外这条 seam 自带审计：`request()` 先追加 `approval/asked`、再追加 `approval/decided`（两者都只写日志、不进模型上下文）。P1 的对账可以直接读这两类事件，比猜 `unreviewed` 强。
