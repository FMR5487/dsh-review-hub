# CHANGELOG

## 1.0.49 — AI 超时后真正弹出超时卡

- 现象：AI 超时后悬浮卡直接消失，看不到「AI 审批超时，未给出结论」这张本该出现的卡。
- 根因在**选行条件**：`syncAdviceOverlay` 只认三种行——「仍在审阅且已交权」「硬风险」「有 AI 理由」。而超时行是 `aiReviewed: true`、`aiSource: 'timeout'`、`aiReason: ''`、`riskLevel: 'unknown'`，**四种条件一条都不满足**，于是卡在最该出现的那一刻消失。
- 修法：补一条「送审了但没有结论」的选行分支（`aiSource` 非空且 `aiReason` 为空）。渲染侧本来就有红边 + `AI 未给出结论` 芯片 + 「AI 审批超时，未给出结论 —— 请你判断」文案，只是永远没被选中过。

## 1.0.48 — 审阅中卡按时停转；L0 标记；文案精简

- **转圈不停**：`row.aiReviewed` 原本要等整个交权赛跑结束（也就是等人点完）才置真，所以 AI 在 16s 已超时返回、卡片却一直转到 22s。现在 AI 一返回就立刻写 `aiReviewed` / `aiSource` / `aiReason` / `aiRisk` 并广播，卡片当场换成「AI 未给出结论」。
- **L0 标记**：命中硬风险的审批，审批页的决策芯片改为 `命中L0 · 人工通过` / `命中L0 · 人工拒绝`——只写「人工通过」会隐藏它为什么被交到人手里。
- **审阅中文案精简**：删掉「可以先点按钮，你的决定不会被它的结论覆盖」那行（交权后这句话由面板本身表达），并在转圈字形前加一个空格，避免 `已 12s│` 粘在一起。

## 1.0.47 — 丢弃结论时记下原文（取证）

- 1.0.46 之后仍然出现 `aiSource: "error"`、`aiReason` 为空，但 `review-probe.log` 只有 `usage` / `finish` 块——**看不出模型到底回了什么**。
- 新增 `noteAnswer`：结论被丢弃时，把 finish reason 与回复前 300 字符写进 `review-probe.log`（仍受 `记录评审流（取证）` 开关控制）。下次一条测试就能区分是「被截断」「空回复」还是「格式不符」。

## 1.0.46 — 先解析结论，再看 finish reason

- 现象：台账连续两条 `aiSource: "error"`、`aiReason` 为空，但取证日志里明明有 `usage` 与 `finish` 块——**模型答了，插件把它丢了**。
- 根因：`review.js` 在解析之前先判 `answer.reason !== undefined`（流结束原因，如 `length` / `max_tokens`）就直接 `fallback('error')`。只要 finish reason 不是干净结束，**哪怕回复里已经带着完整结论也被整条丢弃**；而 `maxTokens` 这个参数在部分 provider 上不认，很容易触发这种 finish reason。
- 修法：**先 `parseVerdict`，解析失败才看 finish reason**——前者成功即为有效结论；失败时把 finish reason 原样记进 `aiSource: error` 的说明，方便区分「被截断」与「根本没答」。

## 1.0.45 — 高级设置改为自动保存

- 所有控件（数字、文本、textarea、开关）都走同一个 `change()`，现在它自带 **600ms 防抖写盘**，不再需要按「保存」。输入框失焦/停止输入即落盘，状态行显示 `已保存`。
- 组件卸载时清掉待发的定时器，避免「改完立刻关页面」丢一次写入。
- `toggleNow` 保留为 `change` 的别名——它当初存在的理由是「开关只改 draft 不落盘」，那个理由已经消失。

## 1.0.44 — 交权之后：谁先答谁赢

- 8 秒交权不再立刻 `abort()`。现在先把人工选项摆出来、同时让 AI 继续跑，然后 `Promise.race(review, humanPromise)`：
  - **AI 先回 `allow`** ⇒ 直接放行（`decidedBy: "ai"`），面板随之关闭，人不用点；
  - **AI 先回 `ask`** ⇒ 继续等人（人已经在被问了，不重复问）；
  - **人先点** ⇒ 按人的，`abort()` 掐断 AI，台账记 `aiSource: "aborted"` + `aiLate: true`；
  - **AI 超时/故障** ⇒ 继续等人，原因进 `aiSource`。
- 你提出的语义是「人工选项出来后 AI 迟到出结果、而人还没决定 ⇒ 应该听 AI 的」，这条现在成立。

## 1.0.43 — 落定行不再丢 AI 字段

- 根因：`finished` 是逐字段拷贝的快照，而点亮 `aiSource` 的只有 `aiNote` 分支——**交权路径下 `verdict` 是 `undefined`，那条分支永远不执行**，于是台账出现「`tier: ai` 却没有 `aiSource`」的黑洞。
- 修法：落定时把行上已有的 `aiSource / aiSkip / aiReason / aiRisk / aiLate / aiUsage` 一并带上，谁先谁后都不丢。
- 另补第三种「没送审」原因：`ai-off`（档位是 ai 但审查器返回空）。

## 1.0.42 — 人工接管时中断审查器

- `collect()` 接受外部 `AbortSignal`（与它自己的超时计时器「谁先到谁掐」），`decide()` 在交权/人工先答时 `abort()`，**真的把流断掉**而不是丢掉结果继续付费。
- `aiSource` 新增 `aborted`，与 `timeout` 分开：前者是「人接管了」，后者是「AI 太慢没人接管」。

## 1.0.41 — 悬浮卡回到对话列顶部

- 没有可滚动祖先时，卡片原来落在 `dock.top - 120`，视觉上几乎就是提示卡的位置。改为落在**对话列顶部**（`max(8, min(96, dock.top - 16))`）。
- 卡片在「已决策」的行上立即退场：`decidedBy` / `outcome` 一旦出现就不再渲染，不必等服务端摘行。

## 1.0.40 — 预览样本点击即弹真实悬浮卡

- 悬浮卡的 DOM 构建抽成 `buildFloatCard(t, row)`（原本内联在 `syncAdviceOverlay` 里），预览与真实浮层**共用同一个构建器**——位置、宽度、红边权重、两行文案不会再出现「预览好看、实际偏位」。
- 预览样本可点：AI 通过 / 高危 / AI 审阅中 / AI 超时 各弹一张真实卡，走的是与真实审批**同一条判定链**（审阅中用 `aiReviewed:false + humanAsked:true`，超时用 `aiSource:'timeout'`）。
- `PREVIEW_KINDS` 去掉 `pending`：它在 1.0.31 之后已被「AI 审阅中」取代。

## 1.0.39 — 锚定后的浮层接管全部卡片状态

- 之前系统里**两套浮层并存**：DOM 那套用 dock 的 rect 定位（正确），React 那套用 `.ah-float` 的视口居中（侧边栏一开就偏右），而且**状态判定各写一半**——位置对的那套只有三态，状态全的那套定位错。截图里「偏右 + 宽度不对 + 文案奇怪」就是这两套交叉的产物。
- 现在 DOM 那套承担全部四态：审阅中 / 建议 / 高危 / 未给出结论（红边）；`aiSkip` 的行**不弹卡**。
- 卡片签名加上 `aiReviewed / aiSource / humanAsked / 转圈帧`，否则转圈时签名不变、秒数会停住不刷。

## 1.0.38 — 悬浮卡锚到对话列，而不是视口中心

- 根因不是宽度公式，而是**回退路径**：测量拿不到 anchor 时（dock 尚未布局完），代码清掉内联样式、退回 CSS 的 `left:50%` 视口居中——侧边栏打开时看起来就是偏右、偏窄。
- 修法：放弃之前先自己量一次 `.ah-dock`（`describeDockAnchor`），并用它的 `rect.left/width` 作内联定位；`rect.width` 已含 dock 内距，所以卡片与提示卡**边缘对齐**。

## 1.0.37 — 「没送 AI」不弹卡，只记在详情里

- `aiSkip` 的行直接不进悬浮卡渲染循环（少一次打扰），原因写进审批页详情：`未送 AI：hard-risk:delete`。
- 实现细节：`reasonBlockOf` 在 factory 作用域里拿不到 `t`，所以标签用 locale key（`row.aiSkipLabel`）交给渲染器翻译，值保留原始原因码（机器可读）。

## 1.0.36 — 台账记下「为什么没送 AI」

- 新增 `aiSkip`，三种取值：`hard-risk:<rule>`（硬风险）、`tier:<tier>`（档位表本身不送 AI）、`policy:<agentKind>`（agent 策略压人）。
- 起因是一次误判：某条 `pwsh` 台账没有 `aiSource`，被当成「审查器出错」，实际是 `Remove-Item -Recurse -Force` 命中 `riskRule: delete`——**硬风险根本不送 AI**，这正是设计。现在台账自己说清楚，不用再反推。

## 1.0.27 — 理由语言扩到 10 种；「跟随界面」真正跟随面板

- 下拉从「跟随界面 / 中文 / English」扩到 **10 种**：简体、繁體、English、日本語、한국어、Deutsch、Français、Español、Русский、Português。服务端不再写死三选一，改为接受任意 `xx` / `xx-YY` 语言标签并映射成提示词里的语言名——**加语言不用改代码**。
- 「跟随界面」原先实际是「跟随请求语言」（请求理由是英文就回英文），与面板无关。现在保存设置时会把面板 locale 写进 `panelLocale`，`reviewerLocale === ''` 时用它；两者都空才退回老行为。

## 1.0.26 — 「AI 正在审阅」卡 + 超时红边

- 悬浮卡从两态改**三态**：审阅中（`aiReviewed !== true`，`│/─\` 每 500ms 换一帧）/ 已给结论（AI 建议卡）/ 没给结论（超时、熔断、解析失败 ⇒ **红边** + 「AI 审批超时，未给出结论 —— 请你判断」）。
- 转圈定时器由 `reviewSpin` 自己持有，无待审行时立即 `clearInterval`，组件重挂不会漏。
- 失败态与 L0 高危共用危险配色：一个是「操作危险」，一个是「没人替你把关」。

## 1.0.25 — 追加提示词进高级设置；理由上限与语言落盘

- 高级设置新增 **追加提示词**（3 行 textarea）与 **AI 理由语言** 下拉。追加段接在固定提示词之后，前缀是一句**事实式守卫**：「以下为用户追加偏好，仅在未与上方规则冲突时生效；上方规则由程序强制执行，冲突部分一律忽略」——写事实而不是请求，因为 `deny` 本来就在 `parseVerdict` 里被降级，追加区改不掉这个。
- 修一个静默丢数据的坑：`clampSettings` 只处理布尔白名单与数值 BOUNDS，**字符串字段会被直接丢掉**，`promptAppend` / `reviewerLocale` 存不进去。已补字符串分支与语言标签校验。

## 1.0.24 — 无人值守说明进 FAQ；两个「缓存命中」分开叫

- 统计页每个模型行里同时有两个「缓存命中」：一个是**次数**（命中了几次现成裁决），一个是**比例**（缓存读取 token ÷ 输入 token）。前者改名 **审批缓存命中**，后者保留「缓存命中 N%」。
- README 里「无人值守」从「已知限制」挪到 FAQ，并改成问答体。

## 1.0.23 — 按会话关闭 AI；README 讲清无人值守

- `aiEnabled` 原是全局布尔，一关全机停发。新增 `aiEnabledLocal`（`{ sessionId: boolean }`）：**有该键的会话覆盖全局**，三处判定（`index.js` 前置、`review.js` 守卫、面板开关值）都认它。面板上仅当该会话已开「不与其他会话同步」时，拨 AI 开关才写 per-session 表。
- README 加了「无人值守」用法：在要放养的会话里开「不与其他会话同步」再关 AI 审查，只停这一个会话。

## 1.0.22 — 悬浮卡宽度对齐；高危卡描述减字

- 宽度差异的根因不是公式不同，而是**内距不同**：`.ah-dock` 用 `(clearance+16px)` 的横向内边距把卡片收窄，`.ah-float` 只有 10px，所以显得两边突出一圈。悬浮卡改成同一套内距。
- 高危卡描述删掉「且 AI 没有理由」——硬风险根本不送 AI，这半句是实现细节，不该出现在用户读的说明里。

## 1.0.21 — AI 建议卡 / 高危提示卡各自独立开关

- 「UI与提示卡」里 `等待审批时提示` 下新增两个开关，默认开。门控写在悬浮卡行循环里：有 `aiReason` ⇒ 受「启用 AI 建议卡」管；无理由且 `riskLevel === 'high'` ⇒ 受「启用高危提示卡」管。**没有理由也不危险的「等待中」黄卡不受影响**——诉求是「理由卡太吵」，不该连带把「有人在等你」关掉。

## 1.0.20 — 卡片时长改成各自描述；两个 UI 开关归位

- `AI 卡时长` / `记忆卡时长` 原先共用一句「到点自动收起」。改为**各有自己的描述**：「AI 审批通过的卡片持续时间」「记忆通过的卡片持续时间」——标签不动，只说清这张卡是哪个结论的、活多久。
- `自动展开描述` / `隐藏无用旋钮` 从「审查」区块末尾搬到「UI与提示卡」**顶部**（行级脚本搬移，不手抄代码）。

## 1.0.19 — 设置区块改名「UI与提示卡」

- 「卡片与提示」→ **「UI与提示卡」**，因为它管的不只是卡片，还包括描述展开、旋钮显隐这类界面行为。

## 1.0.15 — 高级设置里的开关改为「拨了就存」；探针取证失败的原因

- **踩到了自己的坑**：高级设置（`ConfigCard`）的开关只改组件内的 `draft`，真正落盘要按「保存」按钮。于是「记录评审流（取证）」看着是开的，`settings.json` 里根本没有这个键（实测：29 个键，无 `debugReview`），探针一行也没写。
- 修法：取证与安全类开关（`debugReview` / `debugHeaders` / `strictVerdict`）改走 `toggleNow()`——先改 draft 再立即 `saveConfig`，与日常设置页的开关行为一致。`启用「清空历史」` 仍保留手动保存：它放出的是一颗红色按钮，多一次确认是好事。

## 1.0.14 — 「顶层 run_code」进对比表；高级设置按「取证 / 危险开关 / 安全开关」重排

- README（中英）对比表新增一行 **顶层 `run_code`**：官方在该调用上`**豁免审查**`（`exec.parent === undefined` 直接放行，避免与子调用重复计费），明镜照样过 L0 硬风险与记忆学习，只是不进 AI——所以「`run_code` 里写 `rm -rf`」在明镜这边会被拦下来问人，在官方那边不会。
- **高级设置重排**（纯顺序，无行为变化）：`记录请求头（取证）` → `记录评审流（取证）` → `启用「清空历史」` → `严格裁决协议`。规则是「两个取证挨着、危险开关紧贴其后的安全开关之前」。

## 1.0.13 — client.js 站内分区（不拆文件）+ 行渲染器提出组件 + 取证开关拆开

- **为什么还是不拆文件**：客户端半身是字符串 bundle，宿主只给它 `react` 一个 `require`，拆开必须有构建步骤把文件拼回一段；而构建步骤会漏、也与你自己的「装插件先查 `prepack` 是否跑构建」铁律相冲突。所以选**站内分区**：文件顶部加区块索引（01 常量与语言字典 / 02 纯函数 / 03 状态与接口 / 04 样式 / 05 组件 / 06 导出），每个区块前有段标。
- **把行渲染器从 `ApprovalPage` 里提出来**：`approvalRowNode(entry, opts)` 现在挂在 factory 作用域，靠显式 `opts`（t / view / copiedId / isReasonOpen / openDiff / copyRow / toggleReason）取外部依赖，组件里只剩一个 `rowOpts` 袋子 + 一行 map。收益：这 85 行不再埋在组件闭包里，可以独立渲染与测试。
- **新增渲染测试**（这是这次重构的安全网）：`__test.approvalRowNode` 用桩 `opts` 渲染一条打回行与一条记忆行，断言出 `ah-row`。缺任何一个 `opts` 字段都会当场红——`t is not defined` 就是这个测试在重构中途抓到的（当时我只替换了 `t(` 的调用，漏了把 `t` 当实参传的 `chipBody(chip, memory, t)`）。
- **评审探针拆成独立开关** `debugReview`（默认关）：原来借用 `debugHeaders`，但两者回答的是不同问题——一个是「哪个 cookie 能写」，一个是「宿主给不给 prompt-cache / 用量计数」，用同一个开关会让取证互相干扰。输出仍在 `review-probe.log`（只记 chunk 的 type 与字段名）。
- README-AI §3 补上客户端的内部区块顺序与「必须保持单文件」这条约束。

## 1.0.12 — 严格裁决协议（可选）+ 官方对照口径入 README-AI

- **新开关「严格裁决协议」**（`strictVerdict`，默认**关**）：开启后模型回复必须是 `{decision, risk, reason}` 这一种形状——字段名叫 `decision`、取值是 allow/ask/deny、`risk` 是 low/medium/high，任一不合规 → `unparsed` 转人工（理由带着模型原话落盘）。默认关的理由写进代码注释：中文小模型用宽松同义词时转人工率更低，严格化等于「更安全但更吵」。
- 严格模式**不影响否决权**：`deny` 依旧降级成 `ask`；大小写不敏感（只严格字段名与风险等级）——这是有意的，capitals 不改变语义。
- **P2 探测已埋点**（`review-probe.log`）：取证开关（`debugHeaders`）打开时，`review.js` 把每个 llm chunk 的 **type 与字段名**写进 `~/.dsh/storages/review-hub/review-probe.log`（只记名字，绝不记值）。目的：确认宿主是否透出 prompt-cache / usage 计数，再决定要不要做「提示词前缀稳定化」。
- README（中英）把「和官方 auto-review」「和 dsh-auto-approve」两节**合并成一节**「和两个最接近的插件的逐项差异」：共用一段定位说明（三者的挂载点各在哪），下面两个小标题分别是权力模型与学习模型的对照表。
- README-AI 增补「与官方 auto-review 的关系」：钩子、`allow` 语义、fail-closed、卸载副作用、两者可共存，并写明改判定语义时不要照它那套。

## 1.0.11 — 官方 auto-review 对照入 README；缓存过期时间进高级设置

- **README（中英）新增「和官方 `@deepseek-ai/dsh-experimental-auto-review` 的差异」**：按官方 `next` = **0.2.2-rc.1**（与本机宿主同版）的 `lib/index.js` 逐处核对——挂载点（`tools/pre-execute` + `AUTO` 预设专享）、AI 能否决（`override=never` 下 `deny` 直接拒绝执行）、审查失败 fail-closed、把**整个会话可见历史 + 原始参数**送模型且无脱敏、无记忆/无预算/无熔断/无缓存、模型固定用会话车道、卸载时把 `AUTO` 会话切成 `danger-full-access`、顶层 `run_code` 豁免审查。表里同时写明两者**不冲突可共存**。
- 竞品表里官方那行的版本号补成 `0.1.6-alpha.1（next = 0.2.2-rc.1）`——只写 `latest` 会漏掉宿主真正跑的版本。
- **新设置项「AI 缓存过期（毫秒）」**（高级设置，`aiCacheTtlMs`，默认 600000 = 10 分钟，0 = 关闭）：字段本来就在 `clampSettings` 与 `CONFIG_FIELDS` 里，只是从来没有界面入口。说明文字写明缓存键**跨会话共用**。

## 1.0.10 — 统计页的 AI 板块：口径、措辞、过期条目

- 「审批合计」只留件数（共 / 放行 / 拒绝 / 取消 / 不可用）；`allow / ask / 兜底` 与缓存数字移进「**AI 调用情况**」（原「使用过的模型」）。一行一个主语：审批合计说件数，AI 板块说调用。
- 「AI 缓存 0/3」拆成两句：`审批缓存 N 条 · 命中 n 次`——**分子是全局缓存池，分母是本会话命中次数**，写成 `0/3` 会被读成本会话命中率。
- **过期条目不再计入缓存条数**：`review.js` 的 `stats()` 现在按当前 `aiCacheTtlMs` 现算「还在 TTL 内」的条目数（`cacheSize`），另保留原始 map 大小 `cacheEntries`。过期条目查不到也用不上，算进去只会让面板自相矛盾。
- i18n：新增 `stats.cacheLine`、保留 `stats.reviewerInline`，`stats.lanes` 文案改为「AI 调用情况」/「AI calls」；中英键数仍对等（回归测试覆盖）。
- README（中英）「已知限制」补一条：**AI 裁决缓存跨会话共享**（键 = 请求方档位 + 参数指纹，默认 10 分钟），所以「本会话 0 次 AI 调用」不等于 AI 没参与。

## 1.0.9 — 徽章退化顺序（先丢「合并」）+ 统计页合并口径

- **窄栏先丢「合并」再丢「次」**：合并现在是记忆句前面独立的一段（`.ah-chip-mem-pre`，`@container (max-width:560px)` 隐藏），480px 才丢单位词，400px 才丢整句。窄栏读作「记忆 3/3 次」——次数是事实，「合并」是注脚。
- **统计页不再有三套口径**：删掉「审查器合计」板块，`allow / ask / 兜底 · AI 缓存 0/3` 直接接到「审批合计」那行后面；「按车道」改名「**使用过的模型**」（它列的就是台账里出现过的车道，叫「车道」没人知道是什么）。`stats.reviewer`、`stats.empty`、`bar.reviewer`、`bar.cache` 四个 locale 键随之删除，新增 `stats.reviewerInline`、`stats.cacheInline`。

## 1.0.8 — 「合并」并入记忆句；UX / CHANGELOG 按轮次重排

- **「合并」不再是独立徽章**：1.0.7 把它做成旁边一个「合并记忆 3/3 次」，紧挨着又一句「记忆 3/3 次」——同一个数字说两遍。现在它只是记忆句的前缀：合并记忆 3/3 次；判定不变（fpMode=normalized + droppedKeys 非空 + memoryCount 至少 2，即同一条命令第二次起）。chipOf() 不再返回 merged，isMerged() 独立成纯函数。
- 随之删掉 .ah-chip-merged 这一组容器查询：合并既已并入记忆句，它的退化跟着记忆句走（560 长句换短句 / 480 丢单位 / 400 整句）。
- **文档按轮次重排**：CHANGELOG.md 的「未发版」逐轮落成 1.0.2 到 1.0.7（一个对话轮次一个版本号），本轮为 1.0.8，package.json 与 README-AI.md 同步；UX.md 的 2026-11-10 由一节拆成第一轮到第五轮，与对话轮次对应。
- 测试：断言改到 isMerged() 与 memoryText().parts.lead（memory.progressLeadMerged 才算合并），并断言 chipOf().merged 为 undefined。

## 1.0.1 — 首个 npm 发布版

- **engine 放宽**：`engines.dsh` 从 `>=0.2.1-rc.1 <0.3.0-0` 改为 `>=0.2.1-rc.1 <1.0.0-0`。原上界会在宿主进入 0.3.x 时把插件挡在声明范围外；本插件的真实耦合面是宿主的席位名、右侧栏 API 与 `--dsh-composer-*` 变量（已在「已知限制」写明），而不是 0.2/0.3 这个大版本号，所以按「装了再说、坏了就修」处理。
- **发 npm**：去掉 `private: true`，加 `publishConfig.access = public`，keywords 补 `approval-gate` / `audit` / `diff` / `memory`（registry 关键词索引是发现渠道）。
- **README 新增「和 `dsh-auto-approve` 的逐项差异」**（中英）：13 行对照表（挂载方式 / 审查范围 / 否决权 / 失败语义 / 危险清单 / 记忆 / 计数来源 / 给模型看什么 / 审计 / UI / 成本 / 已知敞口 / 规模），并给出三条选择建议。左列按其 0.7.1 的 npm 包与 README 核对，右列是本仓库代码事实。
- 含上一轮未发版的 S2 改动：请求头探针（`debugHeaders`）+ 写方法围栏（`writeProofCookie` / `writeProofHeader`，按请求动词判、只拦 POST、读与 SSE 永不拦）。

## 1.0.7 — 合并记忆徽章与窄栏分段退化

- **徽章语义改真**：原「同类合并」只表示「指纹剥过旋钮」，第一次出现也挂，等于说了一条不存在的历史。现在叫**「合并记忆 n/N 次」**（`chip.merged` 带 `{count, threshold}`），且**只在 `memoryCount >= 2` 时出现**——同一条命令第二次起才谈得上「合并」；阈值按行冻结（`rowThreshold`），改设置不会改写旧行。
- **窄栏分段退化**：容器查询按 620（合并记忆）→ 560（AI 打回）→ 480（「次」）→ 400（整句记忆）四档丢组；`memoryText()` 的进度句拆成 `parts{lead, frac, unit}`，宽度不够时只丢单位词，数字留着。
- 测试：`memoryText` 挂进 `__test`；新增断言覆盖「第一次不显示合并 / 第二次显示 / 记忆句三段拆分」。`chipOf().merged` 由布尔改为渲染文本。
- 文档：`UX.md` 目录结构改为「日期 → 轮次 → 条目」（原为「日期＋轮次」同一行标题），170 条记录逐条保留、零丢失。
## 1.0.6 — 记忆页分桶与 fingerprint 透出（修好静默失效的删除）

- **现象**：同一条审批，审批页写「记忆 1/3」，记忆页写「记忆 2/3 · 合并 2 条」。查下去发现本会话两条 pwsh 记忆其实无关（一条 ACL 修复脚本、一条临时迁移脚本），被合成了一桶。
- **根因一（分桶）**：记忆页按 `tool + '\u0000' + 路径` 分桶，没有文件路径的条目路径是空串 → 同一工具的所有指纹落进同一桶，计数按 `sum` 相加（1 + 1 = 2）。文件是「共同主体」时合并有意义，没文件时根本没有共同主体。现在：有路径仍按路径合并；无路径按**指纹**各成一桶，记忆页的数字与审批行 `memoryCount` 重新一致。
- **根因二（字段缺失）**：`memory.json` 只把指纹存在 key 里（`sessionId\0fp`），`store.memoryRows()` 没把 `fingerprint` 作为字段透出，而客户端删除/分桶都在读 `row.fingerprint` → 拿到 `undefined`。于是：分桶退化成按工具合并（即上面那条），并且**记忆页的删除按钮一直在静默失效**（`memoryRemove(session, undefined)` 匹配不到 key，返回 0 条）。现在 `memoryRows()` 补 `fingerprint` 字段；客户端 `rowFingerprintOf()` 在字段缺失时从 key 里兜底解析，`remove` 也改用它。
- 样式：`AI 通过/打回理由` 去掉加粗；风险等级去掉描边（只保留等级色）；「同类合并」的整组隐藏阈值 520 → **620px**。
- 测试：`memoryBucketId`、`rowFingerprintOf` 挂到 `__test`，新增 6 条断言（同工具不同指纹不成一桶、同文件不同指纹成一桶、字段缺失时从 key 取指纹）。
## 1.0.5 — 详情补风险等级 + 徽章按组响应式

- **展开详情加风险胶囊**：AI 理由那一段的标题行现在是 `AI 打回理由` + `风险 · 中`（高/低/未知同款），数据取 `aiRisk`，没有则回落 `riskLevel`；打回与放行两种标签都带。
- **徽章拆成四个独立组**：`AI 打回` / 决定（人工通过…）/ `同类合并` / `记忆 n/N 次` 各自成 span 并自带分隔符。`chipOf()` 不再把 `同类合并` 拼进决定文字，改为 `merged: boolean`；搜索仍能匹配到它。
- **窄栏分组隐藏**（照本插件既有做法，容器查询）：`560px` 记忆长句→短句（原有）、`520px` 隐藏 `同类合并`、`460px` 隐藏 `AI 打回`、`400px` 隐藏记忆句。侧栏展开后徽章不再被省略号从中间切断。
- 测试：`chipOf`、`riskLabel` 挂到 `__test`，新增 13 条断言（拆组后决定文字不含 `同类合并`、`aiRisk` 优先于 `riskLevel`、未知等级原样显示等）。
## 1.0.4 — 「审查器合计」改为按台账派生

- **现象**：本会话三条审批都经过 AI（两条被打回、一条 AI 放行），面板却写「审查器 … allow 0 / ask 1 / 兜底 0」——上面「审批合计 共 3 条」和下面「调用 1」同时出现在一屏，看起来自相矛盾。
- **根因**：审查器那组数字来自 `review.js` 的**进程内计数器**（`stats.calls/allows/asks…`），宿主一重启就归零；而「审批合计」是按 `entries.json` 的行算的。两种口径混在同一屏，重启后必然对不上。
- **改法**：`store.stats()` 从台账行派生 `reviewer`（`aiSource === 'ai'` 算一次模型调用、`'cache'` 只算缓存命中不算调用、其余来源算兜底；用 `decidedBy === 'ai'` 判 allow，其他判 ask；按 `aiModel` 分车道、带 `lastTs`）。`/stats` 用行派生值覆盖实时计数器的同名字段，实时侧只保留台账不知道的东西（缓存大小、熔断状态、是否支持 maxTokens）。
- 顺带的效果：这组数字现在是**按会话**的（过去是跨会话的进程级累计），与本页其它数字同一口径。
- **需要重启宿主**（服务端改动）。老数据同样能算对——口径来自行本身，不依赖当时有没有进程计数。
## 1.0.3 — 展开描述里写出「AI 打回理由」

- 展开描述原本只有一个字符串槽（`reasonOf`），而且 `aiReason` 优先——于是被 AI 打回的行里，**调用方自己的说法被人为顶掉**，看到的只有评审的理由；来自**缓存**的裁决（`aiSource:'cache'`）则连理由都没有，因为 `index.js` 只在 `source === 'ai'` 时才写 `aiReason`。
- 现在分成两段：上面是 `reason`（这次调用自己声明的目的），下面用细线隔开 **`AI 打回理由 · <理由>`**（只在 `aiEscalated(entry) === true` 时出现）。两段同文时不重复；只有 AI 理由时不留空悬的分隔线（`.ah-row-reason-ai-solo`）。
- 服务端补一条：缓存裁决与实时裁决是同一个裁决，理由一并落盘（`index.js` 两处 `source === 'ai'` → `source === 'ai' || source === 'cache'`）。**需要重启宿主**才对缓存来源的行生效；此前写入的老行没有理由可显示，无法追溯。
- **AI 放行的行同样分两段**（用户反馈：AI 通过的行展开后只剩评审理由，看不到这条审批自己的描述）——现在 `reason`（调用方说法）在上，评审理由在下，标签按结论区分：`AI 打回理由` / `AI 通过理由`（`row.aiReject` / `row.aiAllow`）。
- 图标 tooltip 措辞：「展开描述 / 收起描述」→**「展开详情 / 收起详情」**（里面已不只一段描述）。en 同步 `Show details` / `Hide details`。
- 未改 `reasonOf()`：复制/筛选/提示卡仍按旧口径取「一条」描述，避免连带改动。

## 1.0.2 — 审批页「AI 打回」前缀跟随条目配色

- `.ah-chip-pre` 原来把「AI 打回」前缀硬编码成 AI 绿（`--ah-ai-fg`）。于是一行里出现两种颜色：「AI 打回 · 人工通过」前缀绿、条目橙，「AI 打回 · 人工拒绝」前缀绿、条目红——同一行读起来像两件事。改成 `color:inherit`，前缀跟着所在条目的 tone 走（warn 橙 / muted 灰 / danger 红），只保留 `font-weight:600` 做区分。
- 客户端 smoke 测试加断言，锁住「前缀颜色不再硬编码」。

## 未发版 · S2 取证结论 + 写围栏启用

**取证结果**（`http-probe.log`，2026-11-09 实测 59 行 / 面板 56 条 + curl 2 条 + 面板自报 1 条）：

| 信号 | 面板（Electron 渲染进程） | curl |
|---|---|---|
| `cookie` | `dsh-auth-<每实例随机后缀>=…` | **无** |
| `sec-fetch-mode` | `cors` | **无** |
| `sec-fetch-site` | 无 | 无 |
| `origin` / `referer` | 无 | 无 |
| `user-agent` | `@deepseek-ai/dsh-desktop/0.2.2-rc.1 … Electron/44` | `curl/8.21.0` |

- 结论：桌面壳**确实不发** `Sec-Fetch-Site`（这解释了 11-09 的全 403 事故），但它发 **`Sec-Fetch-Mode: cors`** 和宿主自己的 `dsh-auth-*` cookie。后者是唯一真正的秘密（curl 拿不到，页面 JS 也读不到——面板自报的 `document.cookie` 为空，说明它是 httpOnly），所以写围栏键在 cookie 上。
- **cookie 名带每实例随机后缀**（两次宿主启动分别是 `dsh-auth-_clExhUOq…` 与 `dsh-auth-ND41oPpT…`），所以 `carriesProof` 改成**前缀匹配**，否则每次重启宿主围栏就失效。
- 被围栏拒绝时写一行 `denied:"fence"` 到探针日志，避免下次「设置存不下」时还要猜是不是围栏干的。
- 测试 96 passed（新增：带随机后缀的 cookie 认、`xdsh-auth` 不认）。

## 未发版 · S2 取证与写围栏

- **新增请求头取证**（插件配置 `debugHeaders: true`，默认关）：每个请求把 header **名**列表、cookie **名**列表、`sec-fetch-*` 取值、`origin`/`referer` 追加到 `<root>/http-probe.log`，**绝不记录值**，最多 400 行；同时新增 `POST /api/review-hub/probe` 让面板上报它自己 `document.cookie` 能看到的键名（探针关时该路由不存在）。用途：上次 S2 靠猜「浏览器会发某个头」把面板打成全 403，这次先取证再设计。
- **新增写围栏**（`writeProofCookie` / `writeProofHeader`，默认空 = 关）：围栏按**请求方法**判定而不是按路由——`/memory` 与 `/config` 既可读也可写，按路由判会把它们的 POST 漏出去。默认关闭时行为与 1.0.0 逐字一致；读与 SSE 永不拦（EventSource 既不发 Origin 也不带 proof）。
- 新导出 `carriesProof()` / `createProbe()` 供测试直接断言；`test/routes.test.mjs` 新增 2 条用例（proof 为空/指定 cookie/指定 header × 读与写；探针只记名字不记值且有行数上限）。测试 94 → **96 passed**。

## 未发版 · 文档整理

- **移除 README / README-EN 底部的 Star 趋势区块**（上一提交加的，按用户要求撤掉）。

## 未发版 · 竞品与星标

- README / README-EN 顶部「和同类插件的关系」按另一会话（代码审查 + 竞品调研）的建议补齐：新增**四条差异**摘要（AI 无否决权 / 记忆只计人工批准 / 模型只看脱敏摘要 / 完整审批 UI），并把竞品表补上三个此前缺位的对手——官方 `@deepseek-ai/dsh-experimental-auto-review` 0.1.6-alpha.1、`dsh-auto-approve` 0.7.1（功能面最接近）、`dsh-plugin-auto-review` 0.1.0（机器可拒绝，作为反面参照）。每个包名都是实测 200 OK 的链接，版本取自 `registry.npmjs.org/<pkg>/latest`。
- README / README-EN 底部加 **Star 趋势** 区块，与 [dsh-ops](https://github.com/T-Auto/dsh-ops) README 同款（`api.star-history.com/svg` + `star-history.com` 链接，`type=Date`）。

## 未发版 · 文档合并

- `docs/FEEDBACKv2.md` 合并进 `docs/FEEDBACK.md`：原来两批工单分别放在两个文件（§1–§9 指纹 v2，§10–§16 第二批体验工单），编号本来就连续，合并后一份文件即完整脉络；标题改为「问题复盘与工单」，文件头注明两批的时间与来源，CHANGELOG 里对「FEEDBACKv2 §N」的历史引用在合并说明里对齐。
- 这两份文档只在**本机**保留（`docs/` 在 `.gitignore` 里），所以这次提交只包含 README / README-EN 的导航描述更新。
- 教训（值得记）：`docs/` 不入库意味着**删除即不可恢复**。这次合并时 `awk` 静默产出了空文件、`rm` 又已经执行，靠 `git show 1a761a4:docs/FEEDBACKv2.md`（`.gitignore` 生效前那次提交）才捞回来。以后改/删 `docs/` 下的文件必须先在 `/tmp` 留副本并校验字节数，再动原文件。

## 1.0.0 发版收尾

- **插件描述**：`locale/zh.json` / `en.json` 里「AI 预审」与「记忆自动放行」互换位置——记忆是确定性层，排在概率层前面，描述顺序与决策链一致。
- **README 补一段 ops 覆盖说明**（中英）：`dsh-ops` 的 `ops_bash`、只读检索五件与 `job_output` / `job_list` 默认就在 AI 名单里，装好即预审，并链到 [dsh-ops 仓库](https://github.com/T-Auto/dsh-ops)。
- tag `v1.0.0` 已移到当前 HEAD（历史里的自我修复不单独成版）。测试 94 passed。

## 1.0.0 修订五（高级设置整卡崩溃）

- **现象**：重启后插件页「高级设置」整块不见（面板其它部分正常）。
- **根因**：上一个提交给高级设置加「快照保留天数」时用了 `numRow(...)`，而 `numRow` 定义在**兄弟组件 `SettingsPanel` 里**（`client.js:2527`），`ConfigCard` 作用域内不存在 → 渲染到该行时抛 `ReferenceError` → 整张卡渲染失败、什么都不显示。`node --check` 查不出这种错误，而当时没有任何测试真的渲染过这张卡。
- **修法**：`ConfigCard` 自己的 `numberField()` 增加可选 hint 参数，该行改用它；不再跨组件借用构建器。
- **回归防线**：`ConfigCard` 支持一个仅供测试的 `props.debugDraft`（默认不传，行为不变），`__test.configCard` 暴露出来，`client.smoke` 里真的调用它渲染一次。已反向验证：把 `numRow` 那行改回去，测试立刻红（`numRow is not defined`）。
- 测试 94 passed。

## 1.0.0 修订四（S2 回退为可选）

- **S2 的真机结论：桌面壳的请求不带 `Origin` 也不带 `Sec-Fetch-Site`**。上一版把它们当作「来自浏览器」的判据，结果所有请求 403 → 面板 offline、设置全部无响应（用户 2026-11-09 实测）。
- **处置**：默认行为回到 0.4.x 的宽松围栏（`Host` 回环 + 有 `Origin` 时要求同源），严格的「必须来自浏览器」改为**可选**——插件配置 `strictOrigin: true`（默认关）。这样面板绝不因为加固而不可用，想要收紧的环境仍可显式打开。
- 测试改为覆盖两种模式：默认放行无 Origin 请求、`strictOrigin` 下裸客户端被拒。94 passed。
- 待办：若确实要收口，需要先做一次**请求头取证**（把真实请求头名打日志），再按宿主实际发送的头来设计规则——不能再靠假设。

## 1.0.0 修订三（S2）

- **S2 · 本地 HTTP 面不再对裸客户端开放**：`isTrusted()` 的「没有 Origin 就放行」分支改成「没有 Origin 时必须带 `Sec-Fetch-Site`（`same-origin` / `same-site` / `none`）」。理由：`EventSource` 从不发 `Origin`，所以旧代码只能一律放行 —— 连带把 `curl http://127.0.0.1:<port>/api/review-hub/config` 也放行了；而 `Sec-Fetch-Site` 是浏览器强制写入的 forbidden header，页面 JS 无法伪造，`curl` / PowerShell 默认不带。
- 逃生舱：`allowNoOrigin: true`（插件配置，默认关）——万一某个宿主版本不再发 `Sec-Fetch-*`，改这一行即可恢复旧行为。
- 文档：README / README-EN 的「安全边界」同步为「回环 + 同源 + 浏览器上下文」三重校验。
- 测试 93 → 94 passed（新增 8 条围栏断言：同源 Origin、EventSource、dsh-app 协议、裸客户端、跨站、异地 Host、逃生舱）。

## 1.0.0 修订二（S1 / S3）

- **S3 · 命令类硬风险只判能执行命令的工具**：`CLASSES` 现在带 `shape`——`delete / discard / remote-exec / system / batch` 是 `command` 型，只在 `SHELL_TOOLS`（ops_bash/bash/pwsh/run_code…）上生效；`credentials` 是 `path` 型，对所有工具生效。此前 `edit`/`write` 的**正文里出现 `rm -rf` 字样**就会被判成 L0：直接交人工、不进记忆、永不自动放行。写一段文档不是删除。
- **S1 · 快照不再无界留存**（三步全做）：
  - **凭据文件不留正文**：`SECRET_PATHS` 命中的路径（`.env` / `.pem` / `.credentials*` / `channel-pack/` …）只存 `{path, bytes, ts}` 元数据并标 `redacted`，不存 `before`、不存 `afterHint`；`has()` 对这类条目返回 false，因此列表里不会出现撤销按钮（撤销退化为让 agent 自己恢复）。为了能撤销而备份一份凭据，等于制造它本来要防的泄漏。
  - **会话数上限**：新增 `SNAPSHOT_MAX_SESSIONS = 64`，按最近使用淘汰，同时 `rm -rf` 掉对应 `snapshots/<sid>/` 目录。
  - **保留天数**：新增设置 `snapshotRetentionDays`（0–365，默认 0 = 一直保留），启动时扫一次过期目录。
- 新增「快照保留天数」设置项（高级设置，`clear-on` 上方），中英文案齐备。
- 测试 92 → 93 passed（新增凭据红action 用例 + 三条硬风险 shape 断言）。

## 1.0.0 修订（发版前审查修复，同版本号内并入）

- **版本号自愈**：`index.js` 的 `VERSION` 不再手写，改为从 `package.json` 读取（读不到回退 `0.0.0`）。此前它停在 `0.4.55`，`/health` 与插件页都在报错误版本。
- **缓存键分隔符**：AI 裁决缓存键从 `'\\u0000'`（六字符字面量）改为真 NUL，与其它分隔处一致。
- **记忆行的时间戳**：新增 `store.memoryTouch()`——记忆自动放行时只刷新 `lastTs`，**不触碰 count**。计数仍只由人工批准推进（语义不变），但常用操作不再在记忆页里越排越后。
- **旋钮键表防漂移**：浏览器半身那份 `KNOB_KEYS` 暴露到 `__test`，测试断言它与 `store.js` 的版本完全相同。
- **README 补「安全边界」**（中英）：谁可读这个 HTTP 面（loopback + 同源，**无 token**）、`~/.dsh/storages/review-hub/` 里到底存了什么（含 `snapshots/` 的改前全文与明文 `.env` 风险）、怎么彻底清掉、AI 看到什么。
- 测试 92 passed。

## 1.0.0 — 首个正式版

功能面自此冻结，之后的改动以修复为主。回顾 0.1.0 → 1.0.0 的主线：

- **决策链**：L0 硬风险 → 记忆 → 文件级 → AI 预审 → 人工，确定性始终在概率之前；AI 只能 `allow` / `ask`，没有否决权。
- **可审计**：每条记录写明 `decidedBy`、`agentKind`、`tier`、`aiSource`、`aiModel`、`threshold`、`filePath`，事后能回答「为什么没让 AI 看」「AI 打回后谁放的行」。
- **提示卡**：输入框上方的三色卡 + 倒计时环 + 其他会话聚合卡；宿主审批面板会盖住 dock，因此另有一条 `document.body` 级悬浮卡（AI 建议 / 高危两种形态），不参与宿主席位装配。
- **面板**：审批时间线（筛选、搜索、diff、撤销）、记忆页（按文件合并、逐文件自动放行开关）、统计页、设置页（含常驻卡片预览与悬浮卡自测）。
- **数据**：台账导出 CSV/JSON，原子写，写失败降级为内存态。

### 本版整理（发版准备）

- 版本号 0.4.81 → **1.0.0**；`package.json` 补齐 `license` / `keywords` / `repository` / `homepage` / `bugs` / `scripts.test`，`files` 补上 `cordis.patch.yml` 与 `LICENSE`。
- 新增 `LICENSE`（MIT）与 `.gitignore`；删掉 `test.txt` / `test2.txt` / `copy.txt` / `.tmp/` / `.install/`。
- 内部过程文档移入 `docs/`（`PLAN.md` / `FEEDBACK.md` / `FEEDBACKv2.md`），README 与 README-EN 的链接同步；`RESEARCH.md` / `UX.md` / `AGENT.md` 保持在根目录（README 直接引用）。
- 删除死代码：客户端里从未被调用的 `ensurePolling()` / `stopPolling()` / `tick()` 及其 `pollSession` / `pollBusy` / `pollTimer` / `POLL_MS` / `HINT_MS`。真正的轮询一直在 `HintBar` 的 effect 里，这段残留曾让人误判「切会话会清状态」的发生位置。
- 测试 92 passed，`node --check` 全部源文件通过。

## 0.4.81 — 悬浮卡建议文字改正文色（深浅通吃）；高危卡边框真变红

- **建议文字**：`.ah-float-sub` 的 `color` 从 `--ah-ai-fg`（AI 绿）改为 `var(--dsw-alias-label-primary, #ffffff)`——深色主题下是白、浅色主题下自动变成墨色，不靠任何自定义主题开关，因为那正是宿主「正文颜色」的别名。
- **高危边框**：原来给浮层加 `.ah-card-danger` 没生效，因为 `.ah-card-danger` 只设 `border-color`，而 `.ah-float` 用的是 `border` 简写且写在后面，同权重后者覆盖前者 → 边框还是琥珀色。改为新增两类的选择器 `.ah-float.ah-float-danger`（权重更高）指定红色边框，DOM 上同时带 `ah-card-danger ah-float-danger`。
- 测试 92 passed。

## 0.4.80 — 高危待审也走悬浮卡（与 AI 建议同一套显示逻辑）

- **门槛放宽**：`syncAdviceOverlay()` 选行的条件从「有 aiReason」改为「**有 aiReason 或 `riskLevel === 'high'`**」。硬风险请求根本不进 reviewer，所以它永远不会带 AI 建议——但它同样是「只有人能决定」的那一类，正是这张卡存在的理由。
- **高危形态**：徽标换成 `高危`（danger 配色）、卡片边框走 `.ah-card-danger`、副标题写「命中 L0 硬风险（`<rule>`）：不送 AI、不计记忆，直接交给你」。签名里加进 `riskRule`，风险规则变化时会重建内容。
- **dock 不再重复**：既有规则是「浮层存在时 dock 不画待审卡」，因此高危行也一并交给浮层，两处不会同时出现。
- **可自测**：卡片预览里多一个「试一下高危悬浮卡」按钮，合成一条 `riskLevel:'high' / riskRule:'delete' / 无 aiReason` 的待审行，用来验证这条路径（真实高危审批太危险，不该为了测试去触发）。
- 测试 92 passed。

## 0.4.79 — 提示卡绿改 #65c98d；设置页的悬浮卡预览也贴内容列；新增「隐藏无用旋钮」

- **绿色**：`#e9fec3` → `#65c98d`（`.ah-dock / .ah-preview / .ah-float / .ah-card-ai / .ah-card-chip-ai` 上的 `--ah-ai-fg`）。
- **设置页预览的定位**：插件页没有 dock 可量，所以 `CardPreview` 现在自带 `cardAnchor()`——量自己这张卡片（与对话同一条内容列）的 `left/width/top`，宽度取 `--dsh-chat-content-width`（读不到就用卡片宽度 −32），再居中到卡片内。测试按钮把这份锚点直接传给 `syncAdviceOverlay()`，因此不再退化成「窗口居中」。`.ah-float` 的 CSS 兜底宽度也改成与 `.ah-dock` 同一套表达式。
- **新设置「隐藏无用旋钮」**（默认开，位置在「自动展开描述」下面）：显示命令时去掉 `KNOB_KEYS`（limit / offset / page / size / count / max_results / since / until / recent / timeout / …）。**只影响显示**——复制按钮仍然给完整命令，避免审计时拿到删改过的参数。JSON 解析失败（摘要被截断、或本来不是 JSON）时原样显示。
- 测试 92 passed。

## 0.4.78 — 提示卡的绿色统一为 #e9fec3；悬浮卡记住最后一次量到的对话列

- **绿色统一**：`.ah-dock / .ah-preview / .ah-float / .ah-card-ai / .ah-card-chip-ai` 上把 `--ah-ai-fg` 覆写为 `#e9fec3`——AI 通过卡的边框、徽标、复制成功图标，以及悬浮卡的建议行，用同一个平色，不再跟主题的 `state-success-primary` 走。
- **悬浮卡定位**：`adviceOverlay.anchor` 记住最后一次真实测量到的对话列（left/width/top）。插件页没有 dock，测试按钮现在复用它，所以预览也能落在对话区而不是窗口中央；**从未量到过**时按钮下方会明说「还没量到对话列，先回对话页看一眼」，不再让人以为定位坏了。
- 测试 92 passed。

## 0.4.77 — 悬浮卡对齐对话区；卡片预览改为常驻；两处设置文案；README-AI 版本号归位

- **悬浮卡贴对话区**：新增 `describeDockAnchor()`——用我们自己的 `dock` 节点量出对话列的 `left/width`，并向上找最近的可滚动祖先取其 `top` 作为「对话区顶部」，浮层按这组数字定位（`left/width/top` 内联，`transform:none`）。左侧栏展开时窗口居中和对话居中不再混为一谈；宽度直接等于 dock（= 其他提示卡的宽度）。量不到（插件页测试按钮）时退回窗口居中 + `min(560px, 100vw-36px)`。
- **几何每次同步都重算**：内容签名不变时不再重建 DOM，但会重新应用锚点位置，所以开关侧栏、改窗口宽度后浮层会跟着对齐。
- **卡片预览常驻**：删掉 `cardDebug` 设置与开关（store 默认值、`clampSettings` 白名单、`CONFIG_FIELDS`、两条文案一并移除），高级设置里预览卡片始终显示。
- **文案**：「等待审批时显示提示卡」→「**等待审批时提示**」，描述改为「等待审批时显示提示卡」；「等待审批卡时长」的描述改为「0 = 一直留着，直到审批完成」。
- **README-AI.md**：第 5 行的 `版本：0.3.3` 是十几版以前的陈旧戳（文档没跟着发版），改为 0.4.77 并注明与 `package.json` 同步。
- 测试 92 passed。

## 0.4.76 — 悬浮建议卡：顶部居中 + 可自测（不用等真实审批）

- **位置**：`.ah-float` 从 `right:18px` 改为 `left:50%; transform:translateX(-50%)`，即屏幕顶部居中；宽度仍是 `min(360px, 100vw-36px)`。
- **自测入口**：插件页「高级设置 → 卡片预览」多一个「试一下悬浮卡」按钮。它往 `store.pending` 塞一条 `debug: true` 的合成行，然后**直接调 `syncAdviceOverlay(t)`**——不依赖 dock 是否挂载（插件页里 dock 常常不在），12 秒后自动清掉并再同步一次。
- **失败原因可见**：两个开关（「输入框上方提示」「等待审批时显示提示卡」）没开、或审批页正开着导致浮层主动隐藏时，按钮下会给一行具体原因，而不是「点了没反应」。
- **不污染审批列表**：合成行带 `debug: true`，审批页的等待行 `filter(row.debug !== true)` 过掉它。
- 测试 92 passed（zh/en 文案键数一致性仍由现有断言守住）。

## 0.4.75 — 会话名从 `session/title` 事件里读（不再显示「会话 …899195」）

- **证据**：`~/.dsh/sessions/--D-Work-Agent--/session-59708b68…/session.v4.jsonl.zstd` 解压后第 4 条事件是 `{"type":"session/title","data":{"title":"装插件","source":{"kind":"user"}}}`。**标题不是会话对象的属性，而是一条事件**——所以 `session.title / meta.title / descriptor.*` 这些字段探测全都命中不了，toast 只能退到 id 尾巴。
- **修法**：新增 `titleOfSession(agent)`：先做字段探测（某些版本可能真暴露属性），拿不到就按 `latestRoute()` 的老办法**倒序扫事件**找最后一条 `session/title`，取 `data.title`。`titleFor` 直接改为它的包装。
- 测试 92 passed。

## 0.4.74 — 其他会话「只在等、还没决定」时不画聚合卡（toast 却已经弹了）

- **根因**：聚合卡只遍历 `store.others`，而 `others` 只由 SSE 的 `other` 帧累积——那帧是**决定落地**（entry 记录）时才发的；`store.otherPending` 来自 `pending` 帧的 `others`（**正在等待**）。toast 由 `noticeOtherPending(store.otherPending)` 驱动，卡片却只看 `store.others`，于是「别的会话在等、但还没人决定」这一整段时间：通知弹了，卡是空的。
- **修法**：渲染前把两个来源按 `sessionId` 合并（决定行 + 等待行），等待行补 `waiting` 计数与 `lastTs = oldest`，`等待审批 N` 徽标照旧插在最前；只有等待的会话也能出卡，`othersDismissedAt` 水位的语义不变（新请求的 `oldest` 必然大于水位，关掉后再来还会出现）。
- **顺带**：`titleFor()` 探测宿主会话名的候选字段太少（截图里 toast 显示「会话 …899195」，而侧栏明明有名字），补上 `meta.name / descriptor.* / header.title / displayName / agent.meta.title`。
- 测试 92 passed。

## 0.4.73 — 文档：README 补「但」、README-EN 全量同步、README-AI 对齐 0.4.70 后的实现

- `README.md`：FAQ「AI 会不会把危险操作放过去」的约束段前加「但」。
- `README-EN.md` 同步中文版全部改动：新增 `## The decision chain` 一节、`waiting for you` → `awaiting approval`、FAQ 风险措辞重写、删除 session-mix 条目、新增 `Which model should I use?`、高级设置补 `aiTools` / `aiToolsDeny`。
- `README-AI.md` 对齐实现：§1 写死**层序**（L0 → 记忆 → 文件级 → AI → 人工）并点明「记忆命中时 maybeReview 根本不会被调用」；§2 新增红线 13（禁止往宿主审批子席位注册，两次导致 web boot 失败，可见性只能走 body 浮层）；§3 补 `policy.js` 的 `DEFAULT_AI_TOOLS` / `toolsPolicyOf` 与 client 的浮层；§4 row 字段补 `aiModel / clampedBy / filePath / fileDelta / threshold / routeModel / hasSnapshot`，settings 条目补关键字段与「新字段必须同时进 clampSettings 与 CONFIG_FIELDS」；§6 补死代码说明、AI 建议浮层、按会话过滤的三条。
- 纯文档改动，测试 92 passed。

## 0.4.72 — README：补「决策链」一节；文案与 FAQ 修订

- 新增 **决策链** 一节：L0 硬风险 → 记忆 → 文件级 → AI 预审 → 人工，含「确定性在概率之前」的理由，以及台账里 `agentKind` / `tier` / `aiSource` 三列能回答「这条为什么没让 AI 看」、以及「AI 打回」的标注口径。
- 「你会看到什么」：`待人工` → `待审批`。
- FAQ「AI 会不会把危险操作放过去」：改成「会——但具体要看对应模型的能力和你是否信任 TA，这也是这套设计唯一真正的风险点」，并把约束条目收敛到「能约束的部分」。
- 删除 FAQ「审批页的会话/内容串了」。
- 新增 FAQ「推荐使用什么模型？」：够用就好，贵不等于好，但参数越小越容易出错。
- 「设置在哪」补上 0.4.65 引入的两个工具名单设置（追加名单 + 黑名单）。
- 纯文档改动，无代码变化；测试 92 passed。

## 0.4.71 — 「AI 打回」只适用于 AI 之后的层（修正上一版的口径）

- 决策顺序是 **L0 硬风险 → 记忆（精确指纹）→ 文件级 → AI → 人工**（`index.js:279-298`：`decideMemory()` 命中就 `decidedBy='memory'`，只有未命中才进 `maybeReview()`）。所以「记忆通过 + aiSource」是**不可达组合**，0.4.70 把它算作「AI 打回」是错的，测试里那条断言也一并改成 false。
- `aiEscalated()` 收窄为 `decidedBy ∈ {human, external, fallback}` 且 `aiSource ∈ {ai, cache}`——只有排在 AI 后面的层才可能「打过回」。
- 测试 92 passed。

## 0.4.70 — 悬浮 AI 建议卡（不再被宿主人工审批框盖住）；「AI 打回」标记与评审模型名

- **换一条不碰席位注册的路**：宿主的人工审批面板占 composer 席位，我们挂在 `conversation.input.dock` 的等待卡被它盖住。注册进宿主子席位（`conversation.approval.detail`）试过两次、两次都让 web boot 失败（插件 link 一删就好），所以这次走反方向：`syncAdviceOverlay()` 直接往 `document.body` 追加一个 `position:fixed` 的节点（右上角、`z-index` 2147483000）。body 子节点不受任何祖先布局/transform/层叠上下文影响，也不可能参与席位装配，因此**没有启动风险**。内容：等待审批徽标 + 工具与参数摘要 + 「AI 建议：风险 · 理由」；× 关闭只对当前这条生效；审批页可见时（`store.pageVisible`）不显示；组件卸载时移除节点。同一时刻 dock 不再重复画这张卡。
- **「AI 打回」**：`aiEscalated(entry)`——`decidedBy` 不是 `ai`、但记下了 `aiSource`（`ai`/`cache`），说明评审确实看过且裁决是「问人」。行内徽标变成 `AI 打回 · 人工通过` / `AI 打回 · 人工拒绝`，前缀用 AI 主题色。
- **评审模型名**：`review.js` 在裁决里带上 `lane`，answerer 落成 `finished.aiModel`；行内日期左边的模型段优先用它（固定了审查模型时与会话车道不同），否则退回 `routeModel`。`rowModelOf()` 也不再只认 `decidedBy === 'ai'`，被 AI 打回的人工行同样标出评审模型。
- 测试 92 passed（新增 `aiEscalated` / `rowModelOf` 断言）。

## 0.4.69 — 看着审批列表时不再重复弹提示卡；两个设置项改名

- **列表是唯一真相**：审批页用 `IntersectionObserver` 上报自己「是否真的在屏幕上」（`store.pageVisible`），而不是「是否挂载」——标签页保活时挂载态会撒谎。`pendingCard` 卡片的渲染条件多一条：`listIsOpen === false`（当前会话的列表可见时不画卡）。`toast` 同样加上这条，避免「你正盯着列表还要被系统通知打断」。
- **其他会话的卡不受影响**：汇总卡与「其他会话等待人工审批」通知走的是 `others` 通道，仍然全局显示。
- **改名**：「等待审批时也显示黄卡」→「等待审批时显示提示卡」；「人工卡时长（毫秒）」→「等待审批卡时长（毫秒）」（en 同步）。
- 测试 92 passed。

## 0.4.68 — 分档隐藏的阈值整体下调（640/560/500 → 520/450/400）

- 0.4.67 的三个容器查询阈值偏保守：面板还有余量时就开始藏名字，看着像出错。现在倍率 `≤520`、提供商 `≤450`、模型限定词 `≤400` 才让位。
- 记忆句的长短切换（560）与筛选计数的短版（760）没动——那是另外两种信息，太早缩写反而更难读。
- 测试 92 passed。

## 0.4.67 — 窄栏下模型名分档隐藏（倍率 → 提供商 → 模型限定词）

- 侧栏展开、行宽不够时不再用一个省略号糊掉整段，而是**按信息价值分三档让位**（`laneParts()` 把 lane 标签切成 提供商 / 模型 / 倍率 / 模型短名）：
  - `@container (max-width:640px)`：先藏倍率（` · x0.00`）；
  - `@container (max-width:560px)`：再藏提供商（`Qoder/`）；
  - `@container (max-width:500px)`：最后把模型名收成前半段（`Qwen3.8-Flash` → `Qwen3.8`）。
- 完整 lane 仍在 `title` 里，鼠标悬停可看全称；`.ah-row-stamp` 仍是普通行内流，复制出来是单行（0.4.66 的修法不变）。
- 测试 92 passed（新增 `laneParts` 断言）。

## 0.4.66 — 模型段与日期不再黏在一起（`.ah-row-stamp` 去掉 flex）

- **现象**：显示成 `… x0.00·11-08 20:31:53`（分隔符两侧没空格），而复制出来是 `… x0.00` / `·` / `11-08 …` 三行——两个症状同一个原因：0.4.64 给 `.ah-row-stamp` 用了 `display:inline-flex`。flex 容器会把每个 flex 项里首尾的空白裁掉（于是 ` · ` 变 `·`），复制时每个 flex 项又被当成独立行（于是换行）。
- **修法**：`.ah-row-stamp` 改回普通行内流（`white-space:nowrap` + `overflow:hidden` + `text-overflow:ellipsis` 由块自己负责截断），`margin-left:auto` 仍让它整体贴右。子元素降级为行内盒，空格保真，复制得到单行 `lane · 11-08 20:31:53`。
- 测试 92 passed。

## 0.4.65 — AI 工具基线回代码、设置只剩增量；新增黑名单；工具名单改成可换行的 textarea

- **基线硬编码**：`DEFAULT_AI_TOOLS`（shell + 只读文件/检索 + 只读网络 + 任务输出，19 个）就是代码里的默认，高级设置不再回填这一长串。`settings.aiTools` 默认是空数组，语义从「白名单即 AI 面」改成**追加**：这里只写要额外加进去的工具。旧版本写进设置的那一长串会在保存时被过滤掉（`clampSettings` 丢弃已在内置基线里的名字），字段回到只显示增量。
- **新增黑名单 `settings.aiToolsDeny`**：点名的工具一律直接问人，**能盖掉内置基线**，也能盖掉追加名单；记忆档（write/edit 等）不受影响，黑名单也不能把它降级。优先级：内置基线 < 追加名单 < 黑名单。
- **可换行输入**：原来的单行 `<input>` 装满十几个工具名就看不清，改成 `<textarea rows=3>`（等宽字体、`white-space:pre-wrap`、可纵向拉伸），两个字段同款。
- 测试 92 passed（重写工具策略断言，新增基线过滤断言）。

## 0.4.64 — 模型名与日期成为一个右对齐单元（修 0.4.62 引入的间隔）

- 0.4.62 把「·」从模型段挪到日期段后，日期段自己带 `margin-left:auto`，于是模型名贴左、日期贴右，中间空出一大段。现在两者包进 `.ah-row-stamp`（唯一的 `margin-left:auto` 持有者），模型 → 「·」→ 日期 紧挨着，一起右对齐。`.ah-time-stamp` 在组内改为 `margin-left:0`，组外（等待行）行为不变。
- 测试 92 passed。

## 0.4.63 — 文案统一「等待审批」；倒计时环变细；其他会话卡淡白包边 + 文字加粗

- **文案**：`preview.kindPending`、`dock.otherWaitChip`、设置里的两条说明与卡片预览的样例副标题，全部从「待人工」改为「等待审批」（en: Awaiting approval）。和 0.4.61 的「等待审批中」对齐。
- **倒计时环**：`stroke-width` 7 → 3.5，弧更细，实心感减弱但轮廓更清楚。
- **其他会话卡**：`.ah-card-other` 加淡白包边（`color-mix(#fff 32%)`，保留虚线以便与「你需要处理的卡」区分），`.ah-card-main` / `.ah-card-sub` 加粗到 600；徽标胶囊不动。
- 测试 92 passed。

## 0.4.62 — 模型标签不再挂尾随「·」；卡片徽标跟随主题色；卡片按会话显示；倒计时环；卡片预览补「审批进行中」

- **尾随「·」**：模型段原来把分隔符一起吃进 `.ah-row-model`（`laneTag.text + ' · '`），日期被裁掉或缺失时这一行就以「·」结尾。分隔符改挂在日期段（`stamp === ''` 时整段为空），没有日期就没有点。
- **徽标跟随主题色**：`.ah-card-chip` 按卡片种类上色——AI 通过绿（`--ah-ai-*`）、记忆通过蓝（`--ah-memory-*`）、待人工琥珀（`--ah-human-*`）、高危红（`state-error-primary`）。类名由纯函数 `cardChipClass(kind, danger)` 决定，可测。
- **卡片只在对应会话显示**：`HintBar` 渲染时按 `sessionId` 过滤提示卡与待审卡（汇总的「其他会话」卡仍然全局）。切走就消失、切回来还在（只要还没到期）。之前这些卡是模块级数组，跨会话一直显示。
- **倒计时环**：提示卡在关闭按钮左边多一个 14px 环——粗弧顺时针抽干、留下细描边，随时间从「实心」变「空心」。动画用负延时对齐已过时长，与 `pushHint()` 的隐藏定时器同一时钟；`hintMs` 设为 0（不自动消失）时不显示。
- **卡片预览补「审批进行中」**：原来的 pending 样例带「待人工」徽标，其实已经是决定后的卡；改成真正的进行中形态（无徽标、`等待审批中 HH:MM:SS`），并给 AI / 记忆样例加上倒计时环，环与徽标色可在设置页直接看。
- 测试 92 passed（新增 `ringTiming` / `cardChipClass` 断言）。

## 0.4.61 — 凭据类硬风险补到「读=泄露」；待审卡改「等待审批中」；未读徽标按会话归零

- **硬风险路径表补四类**：`.env` / `.env.local` 这类、`*.pem`、`credentials.json`、`channel-pack/`（账号清单与 token 台账）。只读组进了默认 AI 名单之后，读这些文件和泄露它们是同一件事，所以一律落到 human 档：AI 不看、不计入记忆、永不自动放行。`.environment.md` 这类以 `.env` 开头但不是 env 文件的名字不受影响（`\b` 边界）。
- **待审卡文案**：「人工审批中 {time}」→「等待审批中 {time}」（en: Awaiting approval since）。
- **未读徽标不归零（真 bug）**：`refreshUnread()` 数的是 `store.entries` 全部行，而这份 store 跨会话存活（真正的轮询在 HintBar 的 effect 里，每次换会话只重建流、不清行），于是从一个有未读的会话切到干净的会话时，徽标继续把上一个会话的 ai/memory 行算进去。现在①换会话时先把不属于本会话的行剔掉，②计数再按 `row.sessionId === sid` 过滤一次。
- 测试 92 passed（新增凭据类断言）。

## 0.4.60 — 默认 AI 名单加入只读/检索/网络/任务输出组；审批页底部留白加到 200px

- **默认 AI 名单扩到 19 个**：原 `ops_bash/bash/win_bash/pwsh/powerShell` 之外，加入 ①只读文件与检索 `ops_read_files/ops_inspect_local_file/ops_grep/ops_glob/read/grep/glob` ②只读网络 `web_fetch/read_page/web_search/x_search` ④任务输出 `job_output/job_list/ops_status`。浏览器只读组（`browser_*`）与写类工具不在默认名单里。硬风险优先的规则不变：命中凭据/删除/远程执行等 L0 类别的调用仍然直接给人工。
- **审批页底部留白 126px → 200px**：`.ah-list` 的 padding-bottom 加大，最后一条能滚到输入框上方而不是被 composer 盖住。
- 测试 92 passed。

## 0.4.59 — 「先交给 AI 的工具」成为可改设置；AI 行下加说明；记忆忽略理由改名

- **哪些工具先给 AI 现在是设置**：新增 `settings.aiTools`（工具名数组，默认 `ops_bash/bash/win_bash/pwsh/powerShell`），放在插件页「高级设置」里按逗号分隔编辑。语义是**白名单即 AI 面**：名单里的工具升到 AI 档，内置的默认 AI 工具一旦不在名单里就退回人工；`write/edit/str_replace_editor/run_code` 属**记忆档**，不会因为进了名单被放宽（记忆档比 AI 档更强，这条不变）。实现：`policy.js` 新增 `toolsPolicyOf(settings)`（设置里没有该字段时逐字沿用内置表），answerer 的 `classify()` 改用它；`clampAiTools()` 负责去重/去空/单名 ≤80 字符/最多 40 个。
- **AI 审查行下新增一行说明**：「只有允许的工具会先给 AI，详见插件页高级设置」。
- **改名**：「忽略『理由』参与指纹」→「允许记忆忽略『理由』」。
- 测试 91 → 92 passed。

## 0.4.58 — 台账记录 agentKind/tier（AI 为什么没审，终于查得到）；设置项改名与换位

- **可审计性缺口补上**：`agentKind` 与 `tier` 原来只存在于内存里的待审行，落盘的台账两样都没有——于是「这条为什么没让 AI 看」事后完全无法回答。现在两者都写进记录，并在「工具本可以走 AI、却被请求方档位压成人工」时额外写 `clampedBy: 'agent:<kind>'`。这一条是本次排查 51 条全人工记录时缺的正是它。
- **设置改名**：「按文件指纹（全局）」→「允许记忆同文件不同修改（全局）」，描述改为「同一文件的任意修改将会合并成一条记忆，学满即自动放行」，删掉「（指纹改为 tool + 文件路径）」这句实现细节。
- **设置换位**：「自动展开描述」从「自动放行」段移到「不与其他会话同步」下面。
- 测试 91 passed。

## 0.4.57 — 窄栏下「可在『明镜 · 记忆』中开启自动放行」缩成「可开启自动放行」；chip 可压缩不再顶飞日期

- **窄栏换短句**：`memoryText()` 改为返回 `{ long, short }`，行内同时渲染 `.ah-chip-long` 与 `.ah-chip-short`，用 `@container (max-width:560px)` 二选一（与筛选计数同一套容器查询）。侧栏展开时审批行不再被那 26 个字挤爆。
- **chip 不再把日期顶出右边缘**：`.ah-chip` 从 `flex:0 0 auto` 改为 `flex:0 1 auto;min-width:0` + `overflow:hidden;text-overflow:ellipsis;white-space:nowrap`。之前 chip 宽度锁死，宽度不够时它不缩，只能由后面的日期/工具名让位，最坏情况日期被裁掉半截。
- 新增文案键 `memory.canArmShort`（zh/en）。

## 0.4.56 — 记忆页认回真实路径（开关才出现）；日期贴右；审批页加工具下拉；折叠后搜索图标报「已筛选」

- **记忆页三条路径显示不全 + 第一条满却没有开关**：同一个根因。记忆行的 `material` 存的是**压缩过**的参数（`shrinkPaths` 把 `C:\Users\FMR\.dsh\profiles\desktop\cordis.patch.yml` 压成 `…/desktop/cordis.patch.yml`），旧版本又没有 `filePath` 字段，于是面板把压缩串当成了文件路径——显示被截断，且这个假路径永远匹配不上 `/files` 与 `fileAutoPass`（开关拨了也不会生效）。两处修：①`store.memoryRows()` 在行内没有 `filePath` 时，用它记住的 `calls` 去台账里找回真实路径（`row.filePath` 或 `filePathOf(row.argsText)`）；②客户端 `pathLike()` 只认**绝对路径**（盘符 / UNC / POSIX）且拒绝带 `…` 压缩标记的串，最后才回落到 `summary`。第一条满却没开关是同一张网漏的：那条既无 `filePath`、`material` 也解不出路径，只剩 summary（真实完整路径），旧逻辑不含 summary 兜底 → 当成非文件行。
- **审批页日期贴右**：`.ah-main .ah-line{padding-right:78px}` 这条给「动作按钮预留」的内边距本只该加在命令行，却同时压住了第一行，右对齐的日期于是离右边还有 78px。改为 `.ah-main .ah-line + .ah-line`（只有第二行留位）。
- **审批页加工具下拉**：与记忆页同款，选项取自**当前会话**出现过的工具；`筛出 N 条` / 清除 一并认它（清除会同时清空工具选择）。
- **折叠后搜索图标高亮**：`filterOpen === false` 且仍有筛选条件（文本 / 工具 / 起止时间任一）时，搜索图标变主色并带一个 5px 圆点，`title` 变「已筛选 · 点开查看筛选条件」——避免「明明只显示了一部分，界面却像没筛选」。
- 测试 90 → 91 passed。

## 0.4.55 — 阈值随行冻结；「已满」不带数字；记忆页去掉 +N−N、去掉开关错位

- **阈值随行冻结**：记录行新增 `threshold` 字段（`index.js` 写入时取当时的 `settings.threshold`）。审批行显示用 `rowThreshold(entry)`——改阈值只影响**之后**的行，已记录的行保持它当时的分母（3 次人工在阈值 3 下记 `3/3`，改成 4 后仍是 `3/3`，不会变成 `3/4`）。
- **「记忆已满」不再带数字**（`memory.full` = `记忆已满`）：审批页是 `记忆已满 · 可在「明镜 · 记忆」中开启自动放行`，记忆页是 `记忆已满`。
- **记忆页删掉 `+N −N`**：合并后的行本来就没有唯一 diff 可显示（`memoryDelta` 保留给单次行，但列表不再渲染）。
- **开关不再乱入非文件行**：`memoryFileOf()` 去掉「summary 含斜杠就当路径」的兜底——`plugin_manager` 的 JSON 参数里有 `@x/y` 这种斜杠，被误判成文件。现在只有 `filePath` 或 `material` 里的路径才算文件。
- **删除按钮错位修复**：开关与删除包进 `.ah-mem-actions`（`margin-left:auto` 的唯一持有者），不再出现「两个 auto 均分空隙」或「没有开关时按钮停在中间」。
## 0.4.54 — 「记忆已满」只在越过阈值后出现；开关真正贴住删除

- **审批行**：`count > threshold` 才写 `记忆已满 · 可在…`；`count <= threshold` 写 `记忆 {n}/{threshold} 次`——所以才第 3 次（阈值 3）的那一行显示 `记忆 3/3 次`，第 4 次才变成 `记忆已满`。
- 记忆页同一规则（`bucket.count > threshold` 才算满）。
- **开关位置**：`.ah-switch` 与 `.ah-btn` 都设 `margin-left:auto` 时浏览器会把剩余空隙**均分**，于是开关停在中间。改为只有开关吃 `auto`，按钮 `margin-left:0`——开关紧贴删除左侧。
- 阈值上调/下调只影响**判定**（`count >= threshold`），不改已记录的计数；这与「记忆满了之后调阈值不影响放行」的现有行为一致。
## 0.4.53 — 记忆计数改为「逐行累加」与「纯次数」，开关贴住删除，tooltip 收尾

- **审批页计数不再一刀切**：新增 `fileRunningCount()`——同文件的**人工批准**按 `ts` 累加到该行为止，于是列表从下往上读是 `记忆 1 次 → 记忆 2 次 → 记忆 3 次 → 记忆已满 · 已批准 4 次`，增长重新可见（之前每行都显示文件当前总数，全部同时跳到「已满」）。
- **去掉分数形态**：两页统一为 `记忆 {n} 次`；达到阈值后是 `记忆已满 · 已批准 {n} 次`（审批页再接那句 `可在「明镜 · 记忆」中开启自动放行`）。
- **记忆页计数回落改为求和**：文件级计数缺失时用桶内各记忆行 `count` 的**和**（之前取最大值，等于只数了一条）。
- **老行归类**：`memoryFileOf()` 在 `filePath` 与 `material` 都拿不到时，若 `summary` 里带路径分隔符就用它当文件——`edit`/`write` 的 argsSummary 本来就是路径，这样老记忆行不会再单独成一个「没有路径」的桶（截图里第一条没有开关就是这个原因）。
- **开关位置**：`.ah-mem-row-head .ah-switch{margin-left:auto}`，紧贴在红色删除按钮左边。
- **tooltip 去掉「（不再逐条问）」**（zh/en 同步）。
## 0.4.52 — 学满不再写成分数；记忆页计数改用文件级；开关改为置灰而非隐藏

- **审批行**：文件计数达到阈值后不再显示 `记忆 4/3 次`，改为 `记忆已满 · 已批准 4 次 · 可在「明镜 · 记忆」中开启自动放行`（新键 `memory.full`）。分数只在**未满**时有意义。
- **记忆页计数与审批页对齐**：桶的计数改为**该文件的人工批准次数**（取自 `/files`，`decidedBy === 'human'` 的那一套），没有文件统计时才回落到 `bucket.max`。这就是两页数字不一致的根因——左边数文件、右边数单条记忆。
- **开关**：不再隐藏，改为 `disabled` 置灰（`.ah-switch[disabled]{opacity:.4;cursor:not-allowed}`），未学满时看得见、点不动；学满即变为可用。
- 组头「命中」汇总同步改用文件级计数，否则又会和行内数字打架。
## 0.4.51 — 去掉设置里的「按文件自动放行」行；记忆页开关左移且学满才出现；审批行按文件计数

- **设置页**：删掉只读的「按文件自动放行 — 已开启 N 个文件」整行（以及它的两条文案键）。文件级控制只留两处：全局 `fileFingerprint` 开关 + 记忆页里每行的开关。
- **记忆页开关**：位置在 `删除` **左边**；且只有在**该文件计数达到阈值**（`bucket.max >= threshold`）时才出现——没学满的文件不给开关，避免「开了但从不生效」。
- **审批页的行内计数改为按文件**：`记忆 {n}/{threshold} 次` 里的 n 现在用**该文件的累计人工批准次数**（`/files` 的计数），所以同一文件的不同修改会从 `1/3、1/3、1/3` 变成 `1/3、2/3、3/3`；达到阈值后追加 ` · 可在「明镜 · 记忆」中开启自动放行`（`memory.canArm`）。
- **计数口径统一**：`store.fileCounts()` 只统计 `outcome === 'allowed-once' && decidedBy === 'human'` 的行——和记忆阈值同一条规则，避免「文件计数满了但记忆没学」这种前后矛盾。
## 0.4.50 — 记忆页按文件合并；全局「按文件指纹」开关

- **记忆页：同一文件的 edit 合并成一条**。工具组内按 `tool + 文件路径` 分桶：一条行代表一个文件，显示 `记忆 {最高}/{阈值} 次`（学满后换成 `命中 N 次 · 最后命中 …`）、`合并 {k} 条`（桶内多条时）、`+N −N`（桶内**单次**行之和）、`删除`（连点两次，删掉该文件下**全部**记忆行）。文件路径取记忆行的 `filePath`（新行写入时存），老行从 `material` 解析。
- **删除旁边加开关**（逐文件自动放行，`fileAutoPass`）：全局「按文件指纹」**关闭**时才显示；开启时隐藏——那时每个文件本来就已自动放行，逐文件开关只会误导。
- **设置新增 `fileFingerprint`（默认关）**：开启后指纹改为 `tool + 文件路径`（`fileFingerprintOf()`），同一文件的任意 edit 合并成一条记忆、学满即自动放行。answerer 的 `fileArmed` 条件变成「全局开启 **或** 该文件被逐文件开关点亮」。
- **状态保留**：两个开关是**两套独立存储**（`fileFingerprint` 布尔 / `fileAutoPass` 表），全局开关开→关不会清空逐文件选择，回来时原样可见。
- 记忆页不再单列「按文件」区（它的信息已并入每行），`/files` 仍保留给逐文件批准次数使用。
## 0.4.49 — 记忆行只在「单次」时显示 +N −N；「按文件」区始终可见并说明原因；设置页补该设置的状态

- **记忆行 `+N −N` 规则**：一条记忆对应**一次**审批时才有唯一数字——`count === 1` 才显示，且优先用该 callId 在台账里的 `fileDelta`（真 diff），查不到才回落到 `material` 的参数估算。合并过的行（`count > 1`）不再显示。
  - 顺带修掉「有的行有数字、有的没有」：`material` 存盘时被截到 500 字符，长 edit 的 JSON 解析失败 → 以前随机丢数字。现在真 diff 走 `calls[0] → entries` 查找，不依赖 material。
- **「按文件」区改成始终渲染**：没有数据时也显示标题 + 一行原因——`还没有写过文件的审批`，或 `文件统计要重启宿主才会出现（这一版只加了界面）`（`/files` 请求失败时）。这样「功能没生效」和「宿主没重启」能一眼区分。
- **设置页补一条只读状态**：`按文件自动放行 — 已开启 N 个文件。开关在「明镜 · 记忆」页底部的「按文件」里`。设置页原来对 `fileAutoPass` 完全无感，看起来像没生效。
## 0.4.48 — `+N −N` 改用真实 diff 数字（落盘时算一次）

- 新增 `diffStatsFor(snapshot, sessionId, callId)`（`routes.js` 导出），与 `/diff` 路由**同一套** `lookupEntry` + `readAfter` + `computeDiff`。
- answerer 在 `store.record(finished)` 之后（fire-and-forget）算一次该 call 的真 diff，再用**同一个 callId** 二次 `record` 写入 `fileDelta: {add, del}`——`record()` 按 callId 合并，所以只是补字段，不会多一行。
- 客户端 `rowDelta(entry)`：优先 `entry.fileDelta`，没有才回落到参数估算（老行）。列表渲染零磁盘读。
- 口径从此与铅笔页一致：含上下文、`write` 覆盖旧内容的删除、真实磁盘快照对比。
## 0.4.47 — `+N −N` 真正贴住路径

- **根因**：`.ah-main .ah-args{padding-right:78px}` 是给行尾绝对定位的图标留位的，留着 78px 内边距的正是**文本元素本身**——于是 `+N −N` 被隔着 78px 推到右边。把留位从 `.ah-args` 移到 `.ah-main .ah-line`（整行右内边距），文本 `flex:0 1 auto;min-width:0`，chip 就紧跟最后一个字符。
- 图标仍然不会压到文字：留白改在行上，效果与原来一致。
## 0.4.46 — 审批页筛选区：没筛选时显示「筛出 - 条」、改成两行布局

- **空筛选不再报数**：没有关键词/时间条件时显示 `筛出 - 条`（`filter.countNone`）——原来会写 `筛出 51 条`，看着像筛选没过。
- **两行布局**（`flex-direction:column`）：第一行 = 搜索框 + 计数 + `清除`，第二行 = 两个日期。原来五个控件挤一行，侧栏一开就互相压。
- **窄容器自动缩写**：新增 `.ah-view{container-type:inline-size}`，容器 ≤ 760px 时计数由 `筛出 N 条` 换成 `N 条`（未筛选时是 `-`）。两个形态都在 DOM 里，靠 CSS 切换，不重排文本。
## 0.4.45 — 「+N −N」贴到路径后面；记忆页新增「按文件」统计 + 逐文件自动放行开关

- **`+N −N` 位置**：`.ah-main .ah-args{flex:0 1 auto}` —— 命令/路径不再把自己撑满整行，chip 紧跟在文本后面（原来被 `flex:1 1 auto` 推到了右侧图标旁）。
- **记忆页「按文件」区**：列表来自新路由 `GET /api/review-hub/files?session=`，每行 `路径 · 已批准 N 次 · [自动放行开关]`；计数只算 `allowed-once` 的台账行，`filePath` 由记录的 `filePath` 字段（老行回落到解析 `argsText`）。
- **逐文件自动放行（设置项 `fileAutoPass`，默认全关）**：map `<sessionId>\0<filePath> → true`，只保留显式 `true`（`clampFileAutoPass()`，上限 200 条）。answerer 里的判定顺序：**L0 硬风险永远跳过它** → 精确指纹记忆 → 文件级（开关 + 该文件累计批准 ≥ threshold）→ AI → 人工。命中时仍记 `decidedBy: 'memory'`、`row.note: 'file-auto-pass'`，台账可查。
- 记录行新增 `filePath` 字段（`filePathOf(argsText)`：`file_path` / `path` / `target_path`），避免每次统计都重新解析参数。
- 这是你选的 **A + B-as-setting**：A（看得见「该文件已批准 N 次」）+ B 收敛成**逐文件显式开关**，默认关闭；C（文件级「建议」）没做。
## 0.4.44 — 审批/记忆行显示「+N −N」

- 新增 `argsOf()` / `lineCountOf()` / `deltaOf()` / `deltaChip()`：从**参数本身**推改动规模——`edit` 类取 `old_string` / `new_string` 的行数，`write` 类取 `content` 行数。
- 审批页：行内命令/路径后面跟一枚 `+N −N`（绿 + / 红 −，等宽数字）。
- 记忆页：同一枚 chip 放在摘要后面，数据来源是记忆行里保留的 `material`（`toolName\0<json>`，§15a 当初为「将来重算计数」存下来的）。
- 口径说明：这是**参数级估算**，不是真 diff——不读磁盘、不看上下文行；`+N` 是新增文本行数、`−N` 是被替换掉的旧文本行数。
## 0.4.43 — 记忆页三处收尾：空组不显示时间、搜索行占满、行高再降

- **组内一条都没学满 → 只显示 `n 条`**，不再带「最后命中」（那个时间属于尚未生效的条目，容易被当成已学会）。
- **搜索行没占满**：`.ah-mem-filter` 原来只有 `flex:none`，在纵向容器里宽度收缩到内容宽，搜索框随之变短。改成 `flex:none;width:100%;align-self:stretch`，搜索框 `flex:1 1 auto` 吃满剩余宽度。
- **行高再收**：下拉与搜索框 32px → **28px**（min/max 同步），和审批页控件高度更接近。
## 0.4.42 — 记忆页：分组命中统计、工具下拉筛选

- **分组命中统计**：组头在 `n 条` 之外追加 `命中 X 次 · 最后命中 …`，X 只统计**学满**（`count >= threshold`）的条目、时间是这些条目里最新的 `lastTs`；一组里一条都没学满就不显示这段，只留 `n 条 · 最后命中 …`（`memory.groupHits` / 沿用 `memory.groupMeta`）。
- **工具下拉筛选**：搜索框左边加 `<select>`，默认「所有工具」，选项来自当前会话出现过的工具名（按字母序）。宽度固定占该行 `20%`，搜索框占其余；与搜索条件是与关系（先按工具、再按关键词）。`select` 复用 `.ah-input` 外观，`option` 显式给了底色/文字色（Chromium 弹层不继承宿主配色）。
## 0.4.41 — 学满的行不再显示「n/N 次」

- 学满（`count >= threshold`）后进度条信息已无意义：那一格直接显示 `命中 N 次 · 最后命中 …`，两个数字不再重复出现。未学满的行仍显示 `n/N 次`。

## 0.4.40 — 记忆条目：次数紧跟工具名、工具胶囊与审批页一致、学满后显示命中统计

- **次数挪到工具名右边**：`n/N 次` 原来带了 `.ah-time-stamp` 类，而那个类自带 `margin-left:auto`（用于审批行右对齐日期），于是次数被推到右侧。改用 `.ah-mem-progress`（不加 margin），紧贴胶囊。
- **工具名不再过亮**：行内的工具名从自定义 `.ah-mem-chip`（mono + `font-weight:600` + `label-primary`）换成审批页同一个 `.ah-tool`（11px、weight 500、`label-secondary`、淡底胶囊）——两处视觉语言一致。
- **学满才显示命中统计**：`count >= threshold` 时，在次数后面追加 `命中 N 次 · 最后命中 11-07 22:13`（`memory.hits`，等宽数字）；没学满的行不显示（那时它还不能自动放行，统计只是噪音）。
## 0.4.39 — 记忆页：分组可折叠、工具套胶囊、次数与删除提到首行

- **分组可折叠**：组头现在是按钮（`aria-expanded`），点一下收起/展开该工具下的条目；折叠状态存在本地组件状态里，切工具组互不影响。前面带一个小箭头（折叠态朝下、展开态朝上）。
- **工具名套胶囊**：每条记录的工具名改成胶囊（`.ah-mem-chip`，圆角 999px、等宽字体、淡底），和审批列表里的胶囊是同一套视觉语言。
- **「n/N 次」与「删除」提到首行**：每条记录的第一行现在是「胶囊工具名 + n/N 次 + 删除（右靠）」，摘要独占第二行、整行宽。
## 0.4.38 — 记忆页：按工具分组、显示最后命中时间、搜索框修复

- **搜索框变高的 bug**：`.ah-input` 是 `flex:1 1 auto; height:26px`，那是给「横向筛选行」写的；把它放进记忆页的**纵向** flex 容器后，高度就跟着内容走。现在搜索框用独立类 `.ah-memory-search{flex:none;height:32px;min/max-height:32px;field-sizing:fixed}`——`field-sizing:fixed` 直接关掉「按内容定尺寸」，顺带把高度从 26 提到 32。
- **按工具聚合**：一行一个工具组（`ops_bash`、`edit`…），组头显示 `n 条 · 最后命中 11-07 22:13`，组按最后命中时间倒序；组内每条：工具名一行、摘要另起一行（`pre-wrap` 换行保留、长句折行）。
- **最后命中时间**取该组内 `lastTs` 最大值，时间格式复用 `stampOf()`（与审批列表同一套）。
- 删除按钮仍在每条右下（红色、两次确认），搜索在分组前过滤。
## 0.4.37 — 记忆页：红色危险按钮（3 次清空 / 2 次删除）、搜索、文案与标题微调

- **危险操作改成红色 + 多次确认**（`.ah-btn-danger`）：
  - 单条「删除」：第一次点击变成「确认移除」，**第二次**才真的删；6 秒不动手自动复原。
  - 「清空记忆」：需要**连点 3 次**，按钮上传「再点 n 次确认」（复用 `memory.confirm` 文案）；同样 6 秒复原。清空按钮在列表为空时禁用。
  - 注意：设置页里还有一个「清空记忆」是 2 次确认（原有行为，未改）。
- **记忆页加搜索**：顶部输入框按 `工具名 + 摘要` 过滤（大小写不敏感），无命中时显示「没有匹配的记忆」；搜索不改变「已记忆 N 条」的总数（那是全部条数）。
- 文案：`已记忆 {n}` → **`已记忆 {n} 条**」；侧栏标题 `明镜 · 审批统计` → **`明镜 · 统计`**（en `MingJing · Statistics`）。
- 因为 `MEMORY_CLEAR_CLICKS` 在设置卡里已存在（值 2），记忆页的常量改名 `MEMORY_PANE_CLEAR_CLICKS`，避免重复声明。
## 0.4.36 — 侧栏标题「明镜 · 记忆条目」→「明镜 · 记忆」

- 只改文案：`memory.tabTitle`（en 仍是 `MingJing · Memory`），按钮 title 同步为「记忆」。

## 0.4.35 — 复制修复（复制全，不再被截断）、两个图标换位

- **复制不全的真因**：行的复制按钮取的是 `entry.argsSummary`——那是台账写入时**截断到 ~200 字**的摘要（`copy.txt` 里正好断在第 16 行 `process`）。而 §10a 已经把完整参数放在 `commandOf(entry)` 里（读取 `argsText` 并解出 `.command`/`.file_path`）。现在 `copyRow` 走 `commandOf(entry) || reasonOf(entry) || argsSummary`，复制出来是完整命令行。
- **图标换位**：行尾顺序由「展开描述 / 查看改动 / 复制」改为「**查看改动 / 展开描述 / 复制**」（铅笔在前、折叠箭头在后）。
- 顺带核对：dock 卡片的复制（`copyEntry`）本来就用的 `commandOf`，没有这个问题。
## 0.4.34 — 记忆条目改为侧栏页，侧栏标题统一「明镜 · X」

- **「已记忆 N」不再原地展开**：原地展开的那块在窄容器里不能滚动，条目根本翻不到。现在点它 → 右侧栏新 tab `review-hub-memory`，标题「明镜 · 记忆条目」；页内有条数、`清空记忆`、每条一行的工具名/摘要/`n/threshold` 与 `移除`。宿主无右侧栏时退回原地展开（`MemoryBody` 一份实现两处用）。
- **侧栏标题统一**：`改动` → `明镜 · 改动`、`明镜设置` → `明镜 · 设置`、`明镜AI审批统计数据` → `明镜 · 审批统计`、新增 `明镜 · 记忆条目`（en：`MingJing · Change` / `· Settings` / `· Review statistics` / `· Memory`）。
- 打开记忆页时顺手 `store.memory = null` 再 `loadMemory(true)`：切过会话后看到的一定是当前会话的条目。
- 删掉原来那段只给原地展开用的 `memoryList`（已由 `MemoryBody` 取代）。
## 0.4.33 — 顶栏再收一档：按钮不再折行、整块不再被切

- **按钮折行**（截图里的 `已记忆 / 0`）：`.ah-btn` 没有 `white-space:nowrap`，作为 flex 项被压缩后数字掉到第二行。现在 `.ah-bar .ah-btn{flex:none;white-space:nowrap}` —— 按钮永不参与压缩、永不折行。
- **整块被切半**（截图里的 `不可用 (`）：装箱用的是整数 `offsetWidth` 且没留余量，亚像素累积让最后一块被容器裁掉几个像素。改用 `getBoundingClientRect().width`（小数）+ `SLACK = 18px` 余量，宁可少放一块也不切半块。
- 容器 `padding-right` 由 10px 提到 12px，文字与右侧按钮之间固定留白。
## 0.4.32 — 顶栏按真实宽度分组取舍、「已记忆 N」、记忆计数串会话的竞态

- **顶栏文字改成按宽度装箱**：新增 `BarText` 组件，把统计拆成**每项一块**（`共 N 条` / `放行 N` / `拒绝 N` / `取消 N` / `不可用 N` / `下次审批：…`），用 `ResizeObserver` 量可用宽度，从左边开始整块放，放不下的整块隐藏——不会出现「放行」两个字被切掉一半，也不会挤到右侧「已记忆 N」和四个图标（容器 `padding-right:10px` 保底空隙）。比原来 860px 一刀切能露出更多信息。
- **按钮改名**：`记忆操作 N 条` → **`已记忆 N`**（en: `Memorized N`）。
- **43 条 → 0 条会话不刷新（真竞态）**：`loadMemory()` 原来读 `store.sessionId`，而审批页的 effect 可能**先于** `store.sessionId` 更新执行 → 请求打到了上一个会话，晚到的响应又把正确结果覆盖回去。现在：① `loadMemory(force, session)` 显式收会话 id，调用方传自己的 `sessionId`；② 响应回来时若 `session !== store.sessionId` 直接丢弃；③ `memoryRows()` 先看 `store.memorySid === store.sessionId`，并用 `sessionId\0` 前缀过滤条目——数据没跟上时显示 0，而不是显示别的会话的数字。
## 0.4.31 — 三个真机问题的修复

- **①同一行「改动」点第二次，侧栏跑回主页面**：`loadDiff()` 里有一段「同一个 callId 已加载 → 清空 store.diff」的 toggle 逻辑，那是为**行内**展开面板设计的。侧栏 tab 是 rely-mounted 的，状态被清成 `null` 后 `renderDiff()` 返回 `null`，宿主就把 pane 退回主页面。现在只有在 `inline === true` 时才 toggle；侧栏情况下第二次点击只重新 `openTab`（focus），不动状态。
- **②侧栏打开后左侧顶栏文字挤在一起**：`.ah-view` 加 `container-type:inline-size`，容器宽度 ≤ 860px 时隐藏 `.ah-bar-strip`（共 n 条 · 放行 …）与 `.ah-bar-next`（下次审批 …），只留四个按钮；同时给 `.ah-bar-strip` 加省略号兜底，介于阈值附近时也不会互相挤压。
- **③「记忆操作 N 条」切会话不刷新**：记忆是**按会话**的数据，但 `store.memory` 只在打开记忆面板（`showMemory`）时才拉。切会话时既没清也没重取，于是按钮一直显示上一个会话的数字，直到点一下（那次点击触发了 effect）。修法两处：切会话时 `store.memory = null` + `loadMemory(true)`（HintBar 的会话 effect 内），审批页再加一个 `[sessionId]` effect 直接拉一次——计数在面板打开前就必须是对的。
## 0.4.30 — 回退 §10b（右侧栏「审批详情」tab）

- **整块回退**：`DETAIL_KIND` / `sideOpenDetail` / `store.detail` / `payloadOf` / `DetailBody` / `DetailDiff` / `DetailTab` / `preBlock` / `.ah-detail*` 样式 / 行尾箭头 / 行内兜底渲染 / `detail.*` 文案键（zh+en 成对删）全部移除，席位回到 3 个（dock / config / view）。
- 保留 §10a：`commandOf()` 仍做载荷提取（复制与搜索都用它），它不依赖详情页。
- **原因**：FEEDBACKv2 §10b 那段描述本身有问题（详情面要展示什么、箭头与铅笔要不要合并、diff 放哪），用户要先核对清楚再动手，故先拆掉不留半成品。基线仍 90 passed。
## 0.4.29 — 修 §15a 开关点了没反应、补 §15b 自动展开描述、开关挪到标题行右侧

- **§15a 点不动的原因（真 bug）**：`store.js` 的 `clampSettings()` 用一张**布尔白名单**决定哪些开关能落盘，`fpIgnoreJustification` 没在里面 → `POST /config` 收下后立刻被丢掉，前端再读回 false，看起来就是「点了没反应」。已把它加进 `DEFAULT_SETTINGS` + 白名单，并补两条断言锁住（`clampSettings({fpIgnoreJustification:true}) === true`、默认 false）。
- **§15b 自动展开描述**（`autoExpandDescription`，默认 false）：开 → 每条记录默认展开描述，箭头仍可收起；关 → 手动点箭头。实现上把「展开」从「键存在=展开」改成三态（`true` 显式开 / `false` 显式关 / 缺省跟随设置），否则自动展开后点一下会被下一次渲染重新弹开。
- **开关位置**：新增 `.ah-settings-row.ah-settings-toggle{flex-wrap:nowrap;align-items:flex-start}` —— 开关不再被长备注挤到下一行左侧，而是固定在标题行右侧、与标题顶对齐。`row()` 全部走这条规则，设置页里所有开关从此同一列对齐。
- 修 §10c 的尾巴：FEEDBACKv2 文件头那句「采用 B 案，不做自动展开」是整理时没删干净的旧话，用户已确认 §15b 照做，故本轮补上。
## 0.4.28 — 回退 §11（conversation.approval.detail 子席位）

- **回退**：删掉 `conversation.approval.detail` 子席位注册，`AdviceBand` 回到「不挂载」状态（即 0.4.26 行为）；同时删掉依赖它的 `adviceInPanel` 与 `hostPanelPresent()` 门控，dock 的待审卡恢复无条件渲染。`mount()` 仍返回是否挂载成功（无害，供将来用）。
- 席位断言恢复为 3（`conversation.input.dock` / `plugins.bundle.config` / `conversation.view`），抛错测试相应恢复为 2。基线 90 passed。
- **启动失败日志的读法**（2026-11-07T06:57:22 crash，宿主 0.2.2-rc.1）：日志里的失败条目是 **`@deepseek-ai/dsh-client-ui-chat: loading`**——宿主自己的客户端包，不是 `dsh-review-hub`。同一条日志顶部另有一段 `DSH workspace preparation failed: exited with code 3221225477`（0xC0000005，pwsh 崩溃，已知偶发）。所以这次 web boot 失败不是本插件的席位注册导致，但仍按用户要求回退，席位这条路以后不再尝试。
- 另：profile 的 `package.json` 里 `deps`/`bundles` 仍指向 `dsh-review-hub`，而 `node_modules/dsh-review-hub` 软链接被删——这种「声明了但解析不到」的状态本身会让 host 找不到插件，重装链接后才会恢复。
## 0.4.27 — FEEDBACK v2 §10a/§10b/§11/§12/§13/§14/§15a

- **§10a 复制/展示改为「载荷」**：`commandOf()` 现在会 `JSON.parse(argsText)` 后按 `command / cmd / script / file_path / path / target / target_path` 依次取**一个字符串值**；bash 类贴出来就是可执行的命令行，edit/write 类贴出来是路径。解析失败或形状不认识一律回落原文。搜索也改用它做 haystack（原来匹配 `argsText` 原文，会命中 description 噪音）。
- **§10b 行详情 → 右侧栏「审批详情」tab**：行尾新增箭头，打开第 4 个侧栏 tab（`review-hub-detail`）。内容：工具名与时间、`file_path`、`description`、`justification`、`old_string` / `new_string` 各自 `<pre>`（保留真实换行、`pre-wrap`、超 320px 滚动）、其余参数 pretty JSON；行上有写前快照时按需拉 `/diff` 并渲染同一套 unified 行。宿主无右侧栏时同一份内容行内展开，不留死按钮。会话切换清 `store.detail`。
- **§11 AI 建议条嵌进原生审批卡**：`AdviceBand` 注册到宿主子席位 `conversation.approval.detail`（`conversation.approval.detail` 就是 `Zf6DNq_command` 里那个空子席位），位置问题从「对齐」变成「不存在」。注册全程 try/catch，失败不影响其他席位；`mount()` 现在返回是否真挂上。dock 的待审卡在「原生面板在场」（`[data-approval-key]`）且建议条已进面板时不再渲染，避免同屏两张卡。
  - 翻案：当年撤掉该席位是因为 web boot 崩溃，真因是包名撞 `duplicate factory registration`，与席位无关。
- **§12** diff 页的「收起」按钮整删（切换/关闭走 tab 本身），`store.diff` 清理逻辑保留。
- **§13** diff 的「撤销此改动」等数据落地且 `ok===true` 才出现；loading 只画提示行，失败态（no-snapshot/binary/too-large/failed）同样不给撤销。
- **§14 卡片底色 = 输入框底色**：`--ah-card-bg` 改取 `--dsw-specific-input-major`（宿主输入面用的同一个 token，取不到才退 `#2c2c2e`），废除 `#2c2c2e` 硬写与四类 `color-mix` 淡底；AI/记忆/待审/高危只留**包边**（55%/50%/60%/65% 混色）。浅色主题不再翻车。
- **§15a 新设置 `fpIgnoreJustification`（默认 false）**：开 → `justification` 进指纹剔除名单，同命令不管理由怎么写都算同一操作、可累计到阈值；关 → 维持现行为（理由不同就是不同操作）。`normalizeFingerprintArgs/fingerprintOf/fingerprint` 增加可选 `opts`，`index.js` 按设置传入；routes 的 `CONFIG_FIELDS` 已放行。设置页在「放行阈值」下面，带完整备注文案。
- **§15b 自动展开描述：未做**。FEEDBACKv2 文件头已按用户决定采用 B 案（「不做自动展开设置，详情永远手动点开」），故跳过。
- 测试：席位断言从 3 改为 4（新增 `conversation.approval.detail`），抛错测试相应改为 3；基线仍 90 passed。
## 0.4.26 — 「下一条审批」改称「下次审批」、上次审批单独一行

- 审批页顶栏与设置页的文案统一：`下一条审批` → **`下次审批`**（zh 两条键都改；en 仍是 `Next review`）。
- 设置里「上次审批」不再和「下次审批」挤在同一行：拆成两个 `.ah-hint`，各自一行；没有上次审批记录时那一行不渲染（沿用 0.4.25 的 `lastApproval`）。
## 0.4.25 — 统计图标加长、修「上次审批」在没有审批时也显示

- 统计图标的四根竖线整体加长：`M4.5 17V8.5 / 8.5→3.5 / 12.5→10.5 / 16.5→5.5`（底边从 16.5 落到 17，顶端各抬 2–3 单位）。
- **修一个语义错误**：设置页里的「上次审批：…」原来取的是 `/models` 的 `current`，而 `current` 是**会话最近一次请求头**解析出的车道（`latestRoute(agent.session)`）——也就是这个会话聊天正在用的模型，跟审批无关。所以一个从没审批过的新会话照样会显示「上次审批 Raccoon/DeepSeek-…」。
- 现在 `/models` 增加 `lastApproval`：从台账取**本会话最新一条带 `routeModel` 的记录**；取不到就是 `null`，那一段整句不渲染。`current` 语义不变（会话车道，仍用于「下一条审批」的兜底）。
- 新增 2 条断言：无记录时 `lastApproval === null`；落一条记录后 `lastApproval` 等于该行的 `routeModel`。
## 0.4.24 — 「审查器」统计搬进独立侧栏页「明镜AI审批统计数据」

- **顶栏不再常驻两段计数**：`审查器 …` 与 `AI 缓存 …` 从工具条移除（它们占位置、又只在有心算的时候才有意义）。
- **新增统计图标**：四根长短不一的竖线（`stats`），位置在**设置图标左边**；点击打开右侧栏 tab，标题 `明镜AI审批统计数据`。
- **统计页内容**：审批合计（共/放行/拒绝/取消/不可用）、审查器合计（allow / ask / 兜底 + 缓存命中/调用）、以及**按车道**的明细（每条车道一行：调用 / allow / ask / 兜底 / 缓存命中）。数据每 5 秒自取自 `/stats`，数据源仍是宿主进程内存里的 `reviewer.byModel`。
- 宿主没有右侧栏时，按钮退回打开设置页（不留一个点了没反应的图标）。
- 顺带删掉工具条里因搬家而失效的车道选择逻辑（原来那段「取最忙车道」的代码已由统计页自己按车道逐条展示取代）。
## 0.4.23 — 「审查器」那一段改成显示最忙的车道

- 背景：顶栏的 `审查器 <lane> · allow / ask / 兜底` 来自 `reviewer.byModel`——**宿主进程内**按车道累计的计数，只有真的走到 AI 审查层（缓存命中/调用/兜底三条路径）才会建桶。所以它时有时无：本进程一次 AI 都没跑过就没有这一行，重启宿主清零后又消失。
- 修掉一处真错：原来取 `Object.keys(byModel)[0]`，那是「最先插入的车道」。换过 reviewer 模型之后，顶栏会一直念着旧车道（比如已经没有请求的 `qodercn/qfmodel`），和旁边「下一条审批」显示的新车道自相矛盾。现在按 **calls 最多**挑，calls 相同时取 `lastTs` 更新的——`bumpLane` 顺带记 `lastTs`。
- 语义不变：仍是每车道计数，不做跨车道汇总；`AI 缓存 hits/calls` 也还是同一个桶里的数。
## 0.4.22 — 人工色 #f7ad31、图标再降 2px、人工卡改用宿主的排版公式

- **人工色统一为 `#f7ad31`**：`--ah-human-fg` / `--ah-human-bg`（`rgba(247,173,49,.14)`）在 `.ah-dock / .ah-view / .ah-preview` 的变量域里改掉，卡片边框与淡底、行内徽章、时间线 `⋯` 标、待审 chip 全部跟着变；`.ah-tone-warn` 与 `.ah-ink-warn` 里的兜底字面量一并改成同一个值，避免域外回落时色不一致。
- `.ah-row-actions` 的 `bottom`：`-5px` → `-7px`（短命令再降 2px）。
- **人工卡位置改成照抄宿主**（这次是读宿主 `dsh-client-ui-approval/lib/client.js` 得出的，不是猜）：
  - 宿主审批面板占的是 **`conversation.composer`**（priority 1，按 `pendingInteraction` 选中）——有请求在等时它**接管整个输入区**，不是在输入框上方另开一行；
  - 它的外层容器是 `_root{padding:8px calc(var(--dsh-composer-side-clearance) + 16px) 12px; align-items:center}`，卡片是 `_card{width:100%; max-width:var(--dsh-chat-content-width)}`；
  - 我们之前一直用 `--dsh-composer-card-max-width` 并且把 side-clearance 减了两次，所以永远对不齐。现在 `.ah-dock` 直接沿用：`max-width: --dsh-chat-content-width + (side-clearance + 16px) * 2`，`padding: 0 calc(side-clearance + 16px)`，居中交给 `margin:0 auto`。
- 删掉上一版的运行时测量（`dockRef` / `getBoundingClientRect` / resize 重测）：公式对了就不需要量，量反而会跟公式打架。
## 0.4.21 — 图标再下移 5px、其他会话 toast 正文改成「标题（多会话时才带条数）」

- `.ah-row-actions` 的 `bottom` 从 `0` 改到 `-5px`：短命令时按钮与文字之间再拉开 5px。
- **其他会话 toast 正文**：原来恒为 `会话标题（n 条）`，而标题缺失时回落到 `会话 …abcdef`，于是弹出的是「会话 …4301cf（1 条）」这种既没信息量又带括号的东西。现在：
  - **只有一个会话在等**：正文就是它的标题（不带到条数）；20 秒后的重提醒是 `仍未处理：<标题>`。
  - **多个会话同时等**：取 `oldest` 最新的那个会话（最近开始等待的），正文 `<标题>（n 条）`，n 是它的待审条数；其他会话仍在 dock 的聚合卡里。
- 文案键成对新增 `dock.otherWaitingOne` / `dock.otherWaitingAgainOne`（zh/en），旧的两个带条数的键保留给多会话分支。
## 0.4.20 — 回退 0.4.19 的 flex 改动，改为把日期上提到行顶

- **回退**：`.ah-cmd-line` 那套（命令文本与按钮同处一个 flex 行、按钮 `margin-left:auto`、18px 图标）全部撤销；`.ah-row-actions` 回到 `.ah-main` 内的 `position:absolute; right:0; bottom:0`，`.ah-main{position:relative}` 与 `.ah-main .ah-args{padding-right:78px}` 一并恢复，标记也回到「命令行 + 按钮组」两个兄弟节点。
- **改为动日期**：`.ah-time-stamp` 加 `align-self:flex-start`——第一行是 `align-items:center` 的 flex，日期原本被垂直居中、正好压在按钮上方；现在它贴着自己那一行的顶边，与下方按钮拉开距离，命令短的时候也不会看起来挤在一起。
## 0.4.19 — 行内按钮并入命令行（不再 absolute，短命令也不挤日期）

- 问题：`.ah-row-actions` 是行级 absolute，命令短时它会被顶到第一行日期同一高度，两边挤在一起。
- 改法（按定下的方案逐条落实）：命令行升级为 flex 容器 `.ah-cmd-line{display:flex;align-items:flex-end;gap:8px}`；命令文本 `.ah-args{flex:1 0 auto;min-width:0}`；按钮组改为**在流内** `margin-left:auto`，删掉 `position:absolute/right/bottom`；按钮尺寸收到 `18px`（≤ 17px 行高 + 1px 余量），短行时零高度增量。
- 连带清理：`.ah-main .ah-args{padding-right:78px}` 的预留（按钮不再叠在文字上，不需要留白）、`.ah-main{position:relative}`（已无绝对定位子元素）。
## 0.4.18 — 未决时不再谎称「人工通过」、图标回到代码基线、人工卡宽度只减一次

- **待审卡片去掉裁决胶囊**：卡片在**决策发生之前**就渲染，却打着 `人工通过` 的胶囊——等于替人先把话说完了。现在只有 `chip` 非空才渲染胶囊；待审卡在非高危时**不显示任何胶囊**，高危仍显示 `高危`（那是事实，不是裁决）。`cardNode()` 里空字符串 = 无胶囊。
- **行内按钮回到代码基线**：上一版为了拉开与日期的距离给了 `.ah-main` 10px 下内边距，结果按钮比命令行低一截。现在 `.ah-main` 无下内边距、`.ah-row-actions` 锚 `bottom:0`——按钮底边与左侧代码块底边齐平。
- **人工卡宽度只减一次**：`.ah-dock` 的宽度原来是 `100% − side-clearance×2 − inset×2`，而这一行本身已经被 composer 的 side clearance 内缩过——等于减了两次，卡片必然比原生审批卡窄。现在宽度 `100%`，只保留 `max-width: card-max-width − inset×2`，居中交给 `margin:0 auto`。
- 原生审批卡在场时仍以它的实测**宽度**为上限（`[data-approval-scroll]` → 最近的 `*_card`），不再计算左偏移——偏移在不同父容器之间换算必有一处错，居中本来就够。
## 0.4.17 — verdict 解析加固、指纹剔除 description

- **`parseVerdict()` 加固**：字段名接受 `decision` / `verdict` / `action` / `result`；取值大小写不敏感；`allow/allowed/approve/approved/allow-once` → allow，`ask/review/escalate` → ask。仍然只解析**结构化 JSON**，绝不从散文里猜 allow/ask；猜不出照旧 fail-closed 转人工。
- **`deny` 现在保留理由**：以前直接判 invalid、连模型给的理由一起丢掉；现在降级为 `ask` 并**带上 `risk` 与 `reason`**——AI 依然没有否决权，但人在卡片上能看到「它为什么想拒绝」。测试从「deny → undefined」改为「deny → ask 且 reason 保留」。
- **指纹剔除 `description`**（`KNOB_KEYS` 增一）：`description` 是「为什么问」，不是「要做什么」，同一条命令换一句说明不该算两次操作——这正是「批了两次、记忆计数还是 1」的原因。`justification` **故意不剔除**：那是人批准提权前要读的证据，不同理由必须分开。
## 0.4.16 — 诊断信息不再冒充 AI 描述、人工卡对齐原生审批卡

- **「无描述」不再出现 `reviewer reply was not a verdict`**：那句话是 fallback 的**诊断**（`aiSource` 里已经写着来源），不是模型的建议。现在只有 `aiNote.source === 'ai'`（真的拿到了 verdict）才写进 `aiReason`，`aiSource` 仍如实记录 `unparsed`/`error`/`unavailable` 等。
- 旧记录兜底：客户端 `reasonOf()` 加 `isDescription()`，把 `reviewer reply was not a verdict`、`reviewer failed:…`、`no llm service`、`ai disabled`、`breaker`、`budget` 这类诊断串当成「无描述」——于是没有描述的行**不再出现展开按钮**，卡片上也回到「等待你的决定」而不是那句怪话。
- **人工卡（输入框上方）对齐原生审批卡**：新增运行时测量——找 `[data-approval-scroll]`（原生审批面板 body），取它最近的 `*_card` 祖先，读取 `getBoundingClientRect()`，把宽度与左边距套到我们这张卡上；没有原生卡时回落到原来的 composer 宽度规则。窗口 resize、待审条数变化都会重测。
## 0.4.15 — 按钮与日期拉开距离、命令不再弹 tooltip

- **按钮离日期太近**：`.ah-main` 加 `padding-bottom:10px`，按钮（仍锚在该块右下角）随之下移 10px，与日期行分开；展开描述时位置依旧不变。
- **命令上去掉 tooltip**：`.ah-args` 不再设 `title`。命令已经完整铺在行内，悬停再弹一份重复内容只会挡住相邻行。想看描述就用行右下的向下箭头。
## 0.4.14 — 展开描述时按钮不再跟着往下跑

- 问题：`.ah-row-actions` 是 `position:absolute; bottom:4px`，锚在**整行**的底部；展开描述把行撑高，按钮就被推着往下滑。
- 修法：把两行文本与按钮一起包进 `.ah-main{position:relative}`，按钮改成锚在 `.ah-main` 的右下角——展开块在它**下面**，高度变化不再影响按钮位置。
- 顺带给 `.ah-main .ah-args` 留 78px 右内边距，长命令的最后一行不会钻到按钮底下。
## 0.4.13 — 描述改成可展开：向下箭头打开，向上箭头收起

- **新增每行的展开按钮**：位于「改动（铅笔）」左边；该行没有改动按钮时就在「复制」左边。图标是向下箭头，点一下在命令行**下方**展开这段审批的描述（`aiReason` 或 `reason`），再点收起，图标变向上箭头。
- **只在有描述时出现**：没有描述的行不显示这枚按钮，避免留一个点了没反应的图标。
- **展开状态存在组件 state 里**：审批页每来一帧 SSE 都会重渲染，闭包变量会被丢掉，所以用 `{ [rowId]: true }` 记在 `useState` 里。
- 展开块 `.ah-row-reason` 用 `bg-layer-2` 淡底 + `pre-wrap`，长描述会折行而不是横向溢出。
- 悬停 `title` 保留（命中时仍然先给命令再给描述），但不再承担「看描述」这件事——原生 tooltip 在桌面端不一定可靠，现在有明确可点的入口。
## 0.4.12 — 审批行显示完整命令，悬停看命令而不是看理由

- **记录里存下整条命令**：审批行新增 `argsText`（截到 4000 字符，超出时另带 `argsTextTruncated`）。原来只存 `argsSummary`（200 字内的摘要），长命令在列表里被 `max-height: 4 行` 截断，悬停又只看到理由——等于让人批准一条自己看不见的命令。
- **行内不再截断**：`.ah-args` 去掉 `max-height/overflow:hidden`，命令按 `pre-wrap` 完整铺开，行高随内容长。
- **悬停显示命令**：`title` 现在是「整条命令 + 空行 + 理由」；原来只有「理由 + 摘要」。
- **复制与搜索跟上**：复制按钮复制整条 `argsText`；搜索框也一起匹配 `argsText`。旧记录没有该字段时自动回退到 `argsSummary`，不会空白。
## 0.4.11 — 插件页换上一句座右铭（居中、双语）

- 插件页卡片顶部原来那两行（镜像图标 + `明镜 (dsh-review-hub)`，加一行 `AI 预审 · 记忆放行 · …`）换成**居中的一句**：`AI 是灯下献策的幕僚，镜子只负责把每道审批照得清清楚楚。`——与 README 首屏那句同源。
- 中英文成对：en 用 `README-EN.md` 里已有的译文 `The AI advises from the lamp; the mirror only makes every approval legible.`，不走单独另译，避免两处措辞漂移。
- 插件名不再在卡片里重复一遍（页面标题已经是「明镜 (dsh-review-hub)」），`config.brandSub` 与 `.ah-card-brand` / `.ah-brand-mark` 一并删除，不留死键与死样式。
## 0.4.10 — 齿轮重画、卡片底色对齐深色对话框

- **设置图标换成能认出来的齿轮**：上一版那条路径是手写的齿形折线，在 16px 下糊成一团。现在按极坐标生成 16 个顶点的齿圈（外半径 8.4 / 内半径 6.2）+ 中心圆 r=2.7，浅齿、对称，16px 仍能读出「齿轮」。
- **卡片底色改成 `#2c2c2e`**（与深色模式下的对话框同色）：新增 `--ah-card-bg`，`.ah-card` 与三种彩色卡、危险卡的 `color-mix` 底色全部改用它，淡色叠加不再压在一层偏蓝的基色上。浅色主题下也会是这块深色——这是按「深色模式一致」的取舍显式做的。
## 0.4.9 — 修正 0.4.8 的三处误读，行内模型改成宿主的名字

- **记忆计数只从提示卡上去掉**：0.4.8 把它也从审批列表行里删了，那是错的。现在列表行恢复 `人工通过 · 记忆 3/3 次`（`memoryText()` 拼回 `chip.text` 后面），而输入框上方那张记忆提示卡仍然是干净的 `记忆通过`。
- **行内模型只给 AI 行**：记忆与人工不写 `Memory`/`Human`（那是废话，徽章已经说了）；位置挪到最右、日期紧左边，形式是 `qodercn/Qwen3.8-Flash · 免费 · 11-06 08:32:42`，不再套胶囊。
- **模型显示改用宿主的名字**：新增 `laneLabel()`，用 `/models` 目录把 `provider/model` 的 **id** 映射成 `providerName/modelName`，和宿主的模型选择器一致（`qodercn/qfmodel` → `qodercn/Qwen3.8-Flash · 免费`）。行内、顶栏「下一条审批」、设置里的「下一条审批/上次审批」三处共用；目录里查不到时退回原始 id。
- **图标换成宿主同款**：设置（原滑杆）改成齿轮，复制改成两页叠放；两者都是 20×20 stroke 手绘路径，跟宿主截图对齐。
## 0.4.8 — 按会话独立的审查模型、每条审批标出所用模型、行内手感整理

- **卡片文案去后缀**：高危卡从 `高危 · 直接人工` 改成 `高危`；记忆卡不再拼 `· 记忆 3/3 次`（记忆列表里那串计数保留，那里才是它该出现的地方）。
- **下拉可读性**：`<select>` 的选项在 Chromium 弹层里用自己的 background/color，之前吃到默认浅色导致「浅底浅字」。给 `select.ah-input`、`.ah-input option`、`.ah-input option:disabled` 分别上主题变量。
- **「不与其他会话同步」开关**：新 settings 字段 `reviewerModelLocal: {"<sessionId>": "provider/model"}`，**键存在**即为该会话独立（值为空串 = 跟着本会话自己的车道），键不存在 = 跟随全局 `reviewerModel`。归一化 `clampReviewerModelLocal()` 只收 string→string、key≤80、value≤120、最多 32 个会话（超出删最早的），非法输入整份回 `{}`。
- `routeOf()` 改为三级解析：本会话键 → 全局 pin → 会话车道；**本会话键为空串时直接归零，绝不回落全局 pin**（否则「独立」是假的）。切分逻辑抽成 `splitRoute()` 供 `index.js` 与 `routes.js` 共用。
- `/models` 新增 `next`：下一次审批会用到的车道（含本会话 pin）；`current` 语义不变（会话最近一次真实请求的车道）。设置里的「实际使用」相应拆成 `下一条审批：…`，与 `current` 不同时再补 `· 上次审批：…`。
- 审批页工具条右侧新增 `下一条审批：<lane>`（省略号截断，拿不到就不渲染）。
- 每条审批记录新增 `routeModel`（本次裁决解析出的车道），行内**日期左侧**显示：AI 行显示 model 段（`title` 给完整 `provider/model`），记忆行显示 `Memory`，人工行显示 `Human`。
- 行内「改动」按钮从第一行挪到右下角、位于「复制」左边，图标从旧造型换成**铅笔**；`openDiff` 与右侧栏 tab 逻辑未动。
- 测试：84 → **90 passed**（新增 routeOf 三级解析 3 例、`reviewerModelLocal` 归一化 1 例、`/models` 的 `next` 1 例、`/config` 读写 1 例）。
## 0.4.7 — 审查模型改「宿主真实目录」两级选择、卡片调试改设置内预览

- **审查模型不再手填**：设置里的选择器改成 **provider → model 两级下拉**，数据来自宿主 `llm.listProviders()` 与每个 provider 的 `llm.listModels()`（新增 `src/catalog.js`）。此前名单只来自「本插件见过的车道」（`observedReviewRoutes()`），新装或一直走人工的实例永远是空的，于是只能手填 `provider/model`。
- 目录采集有边界：单 provider 1.5s 超时，失败只让该 provider 返回空目录并在 `errors` 里记 `timeout`/`throw`，整体 60s 缓存、`?refresh=1` 绕过；宿主没有 llm 服务时返回空目录并回退手填，不抛错。
- `/models` 响应扩成 `{providers:[{id,name,models:[{id,name}]}], observed, models, current, errors, fetchedAt}`；`models` 保留为 `observed` 的别名，向后兼容。
- `routeOf()` 修 provider 解析：按已知 provider id 的**最长前缀**切分（model id 自己带 `/` 时不再切错），匹配不到才退回第一个 `/`；未 pin 的行为与其他返回值逐字不变。
- 选择器下方显示「实际使用」车道与目录刷新时间；目录外的已存值保留并标 `⚠`，不静默改写。
- **卡片调试从独立窗口改为设置内预览**：删除 `openCardDebug()`。那段实现拼的内联页面在 `'};}'` 处多了一个 `}`，整段 `<script>` 解析失败，窗口里只剩标题和点不动的按钮——这就是「空壳」的原因。改为 `CardPreview`：拨开关即在设置卡下方出现预览，5 种卡片可点选切换，另带「最近 6 条」与「待你审批」两段实时。
- 卡片渲染抽成 `cardNode()`：待审卡、提示卡、其他会话卡与预览共用同一份 DOM，样式不再有第二份。
- 设置项文案 `卡片调试窗口 / 打开就弹出独立窗口` → `卡片预览 / 打开后在设置里显示`（弹窗删掉后旧文案已成假话）。
- 版本号与 `src/index.js` 的 `VERSION` 从 `0.1.0` 对齐到 `0.4.7`（此前二者落后 CHANGELOG 六个版本）。
## 0.4.6 — 数据目录一并改名（彻底）

- `src/store.js` 的默认根目录 `~/.dsh/storages/approval-hub` → **`~/.dsh/storages/review-hub`**（此前因宿主占用导致 rename 失败，保留了历史名）。
- 实测迁移：`approval-hub` 目录整体改名为 `review-hub`，`entries.json`（33 条 / 3 会话）、`memory.json`（23 条）、`settings.json`、`snapshots/` 全部随迁，**记录零损失**。
- 文档同步（README/README-EN/README-AI/AGENT 里的路径说明）。
- 说明：浏览器侧 `localStorage` 的键早在改名时就已是 `review-hub:floor|seen:<sid>`，这次不再有旧键残留。

## 0.4.5 — 顺序、通知门限、设置进侧栏（第一版）

- 审批页列表恢复**最新在上**（只有输入框上方的提示卡是往下堆、最新的在最下面）；分割线文案随之回到 `以上为新增审批`。
- **窗口有焦点时不弹 toast**：`document.visibilityState === 'visible' && document.hasFocus()` 时，当前会话的待审不再重复通知（原生面板就在眼前），花掉一次通知权限配额；窗口失焦/最小化时才弹。
- 其他会话等待审批的 toast 改为固定标题 **`其他会话等待人工审批`**，第二行 `会话标题（n 条）`。
- **设置搬进右侧栏**（第一版，不做折叠）：新增 tab 类型 `review-hub-settings` + `sidebar.right.pane.tab` 面板，工具条那个滑杆图标改成"打开侧栏设置"；宿主没有右侧栏时自动退回原来的行内面板（`store.settingsOpen`）。
- 设置图标保持不变（滑杆造型），只换了它的行为。

## 0.4.4 — 两行卡片、最新在下、卡片调试窗口

- 审批行压成**严格两行**：第一行 `时间线标记 · 工具胶囊 · 归属徽章 · 时间 · 看改动(图标)`，第二行一行命令（理由与完整参数进 `title` 悬停看）。原来"理由一行 + 参数一行 + 改动按钮一行"的散乱版不再出现。
- 列表**最新在最底下**（像聊天记录），新审批在下面出现；"以上为新增审批"分割线改为在第一条新记录**之前**插入。
- 列表底部留白 210px → **126px**（上次给多了）。
- 高级设置里删掉「全部设置已移到审批页 / 日常开关模型都在那边」两行说明。
- 高级设置新增 **卡片调试窗口** 开关（`cardDebug`）：打开即弹出一个独立窗口，上半屏是三种卡片的固定样例（配色/排版对照），下半屏是**实时**的本会话最近 6 条与待审列表（每 2s 刷新）。纯前端调试台，不写任何数据。

## 0.4.3 — 审批页可读性与"别的会话在等你"

- **别的会话待审批现在会通知**：SSE 的 `pending` 帧增加 `others`（只含 sessionId/标题/条数/最早时间），客户端对每条新出现按 `sessionId|oldest|count` 去重后弹一次系统通知，聚合卡里也加一条 `待人工 n`。
- 命令/参数文本：颜色由 tertiary 提到 secondary（更亮），并**恢复换行**（`pre-wrap` + `overflow-wrap:anywhere`，最多 4 行，超出裁剪）。
- 行与列表底部留白加大（行 `8px 12px 12px`、列表 `4px 0 210px`），展开设置或末行时不再被输入框吃掉。
- 时间线竖轨的 ✓/×/· 改为**只上色不带底**（新增 `.ah-ink-*`，与徽章的 `.ah-tone-*` 分开）。
- 设置图标换成"滑杆"造型（三条横线 + 三个旋钮），不再是会被误读成昼夜模式的齿轮。
- 工具名胶囊改用宿主代码字体变量 `--ds-font-family-code`。

## 0.4.2 — 审批页细节（左轨、图标、导出台账名）

- 行左新增**时间线竖轨**（决策标记 ✓ / × / · + 连接线，最后一行不画线），密集列表也能看出先后。
- 顶部工具条顺序改为 **记忆操作 → 搜索图标 → 设置图标**；「设置」由文字改成齿轮图标（与搜索同为 16px 线性图标）。
- 字体统一：面板用宿主文本字体栈 `--ds-font-family-text`（此前长理由会落到衬线字体），代码/命令用 `--ds-font-family-code`，并开抗锯齿；命令行 11.5px/17px。
- 删除三处"设置已移到插件页"的指引文案（`setting.advancedPointer` / `setting.dataNote` / `setting.clearOnMoved`）。
- **导出台账文件名带上当前会话标题**：`review-hub-<会话标题>-session-<时间戳>.csv`；CJK 标题走 RFC 5987（`filename*=UTF-8''…`），客户端解码后用作下载名。

## 0.4.1 — 审批页交互与密度修正

- 设置面板自身可滚动（`max-height:min(62vh,560px);overflow-y:auto`），展开后不再把整页锁死；同时删掉面板顶部「设置 / 收起」那一行（用顶部工具条的「设置」按钮开关）。
- 工具名（`pwsh` / `run_code` 等）改成灰色胶囊，和记忆项/时间线芯片同一视觉语言。
- 「人工通过」等徽章补上淡色底（此前只有描边+文字色），三类决策现在都是同规格胶囊。
- 图标按钮：初始亮度 .55 → **.78**，并加 `svg{display:block;margin:auto}` 修正不居中；放大镜字形重画到 20×20 盒子正中（圆心 9,9）。
- 每条审批右下角新增**复制**图标（一键复制该次被批准的命令/路径，成功短暂变绿）。
- 命令与理由一律**单行省略**（`min-width:0` + `nowrap` + `ellipsis`，`title` 里给全文），长 JSON 不再把行撑成多行。

## 0.4.0 — 改名：dsh-review-hub · 明镜

- 包名 / 客户端 loader id / locale 命名空间 / HTTP 前缀 / localStorage 键 / 席位 id 全部由 `approval-hub` 改为 `review-hub`（loader id 必须等于包名，否则整个 web boot 失败）。
- 中文名 **明镜**，英文名 **MingJing**；`package.json` 增加 `displayName`，描述改为中英双语定位一句话。
- 新增 `assets/icon.svg`（镜面 + 对勾，无外部依赖），README 顶部展示；中英 README 加了同一句定位：
  > AI 是灯下献策的幕僚，镜子只负责把每道审批照得清清楚楚。
- **数据目录保持 `~/.dsh/storages/approval-hub/`**：改名时宿主正持有该目录内文件，重命名会失败并可能丢历史记录，因此保留历史路径（代码里有注释说明），旧数据无损可用。
- profile 同步：依赖 `link:…/dsh-review-hub`、bundles 第 9 行、`node_modules` junction 全部切到新名，旧 junction 已删除。

## 0.3.3 — 文档校正（同类插件、FAQ、AI 跳转）

- 顶部跳转改成直白指令：**你是 AI？先读 README-AI.md；要自己改代码，动手前再读 AGENT.md**（中英两版同步）。
- 「同类插件」章节重写：删除自用插件（已并入本实现，不再对外说明），改为按 `RESEARCH.md` §4 的真实调研结果列 8 个公开插件，**标注版本与核对日期 2026-11-03**，并写明"这些包会持续更新，引用前先复核"。
- 冲突说明改成准确口径：只在**同样会作答 `approval/request`** 的插件之间冲突；通知类插件（toast）功能互补但要确认不抢答。
- FAQ「AI 会不会把危险操作放过去」原答案回避了真正的问题，重写为：**会**——AI 判 `allow` 时不再问你；并列出三层约束（6 类硬风险不送 AI、判定标准写死、可关 AI 或按工具固定人工）与"时间线就是给你复核用的"。
- 全篇核对：颜色/时长/席位/设置位置/性能数字与当前实现一致；`README-AI.md` 增加"引用 RESEARCH §4 前先复核版本"的提示；清掉仓库内所有"自立门户"字样。

## 0.3.2 — 文档拆分（人 / 英文 / AI / 二次开发）

- `README.md`：中文、面向人（GitHub 默认展示），顶部给出 English 切换与"AI 请读 README-AI.md"的指引。
- `README-EN.md`：英文版，结构对齐中文版。
- `README-AI.md`：**只给 AI 读**的实现规格——红线 12 条、文件与 seam 表、数据契约、HTTP/SSE 契约、客户端状态机、失败模式、验证门槛、安装坑、术语。
- `AGENT.md`：二次开发手册——工作循环、六类"配方"（加设置/加硬风险/改策略/加卡片/加路由/加席位）、代码约定、调试手段、连带影响表、提交前 checklist。
- 措辞调整：不再使用"单一实现"这类作者内部说法；把 `dsh-auto-review` / `（自用的）学习插件` / `（自用的）面板插件` / `dsh-approval-toast` 放进"同类插件"章节做能力对照，并明确"同时启用会出现两个 answerer 抢答"的风险与判断方法（`counters.external` 必须为 0）。

## 0.3.1 — 实时开销优化 + 高级设置归位 + README 重写

### 实时通道

- **突发合并**：120ms 窗口内的多条记录合成一个 `entries` 帧（数组），批量审批不再一帧一条；客户端按行逐条处理，提示卡/基线/未读规则与单条路径完全一致。
- **每行只序列化一次**：帧内容在订阅回调里拼好再写给所有订阅者（此前每个订阅者各 stringify 一次）。
- **背压保护**：检查 `res.write()` 返回值，客户端读慢时先丢心跳，避免宿主缓冲无界增长。
- **心跳 20s → 30s**。
- **页面隐藏即断流**：`document.hidden` 时 `close()`，回到可见先补一次增量再重连 —— 后台挂着时心跳唤醒 4320 次/天 → **0**。

### 设置归位

- 「审批」标签页只留日常项：AI 审查、审查模型、记忆自动通过、放行阈值、提示卡开关、人工卡开关、三档卡片时长、系统通知。
- 插件页改为**高级设置（不要乱改）**，带醒目提示：兜底轮询、每会话保留条数、审查超时、每轮上限、熔断次数、按请求方分档，以及**启用「清空历史」**。
- 两处互相给出指引文案，不再出现"设置散在两个页面、分不清哪个是高级项"。

### 文档

- `README.md` 整体重写（约 12KB）：定位、效果、判定流水线与归属表、**10 条红线**、文件与 seam 表、数据结构、HTTP/SSE 协议、客户端状态机、设置清单、实测性能、优劣、失败模式、测试与改动须知、安装/卸载、排错、术语 —— 面向后续接手的人或 AI。

## 0.3.0 — 卡片只讲本会话的新事 + 设置集中 + 视觉打磨

### 卡片生命周期

- **重启不再回放历史**：卡片有了"基线水位"（`review-hub:floor:<sid>`，localStorage）。首次打开一个会话时把当前最大时间戳记为基线，这一批一条都不出卡；只有基线之后的新审批才出卡。
- **卡片不再跨会话**：dock 席位改为 `inject(sessionId) => ({ sessionId })`，只订阅本会话的列表与待审。之前它读的是全局 `/entries?limit=20`，这就是"别的会话的审批在我这里弹卡"的根因。
- **其他会话改用聚合行**：灰色虚线卡，一卡一会话，写清 `会话名 · AI通过 n · 记忆通过 m`（有人工时追加 `人工通过 n`）。**永不自动关闭，只有 × 能关**；关掉之后同一会话再来新审批会重新出现。
- **三档隐藏时长**（可在设置里改）：记忆卡 8s、AI 卡 30s、人工卡 **0 = 直到你做出决策**（该请求从待审列表消失或你点 ×）。
- **人工卡默认开**（`pendingCard: true`）：需要你决策的请求本来就都过了一遍 AI，卡片里直接显示 `AI 建议人工 · 风险 · 理由`。
- 卡片加高到 44px，右侧两个 SVG 图标按钮：**复制**（工具名 + 参数 + AI 理由，复制成功短暂变绿）与 **关闭**。全部内联 `<path>`，不用 emoji、不放文字。

### 实时化（不再靠猜轮询）

- 宿主新增 `GET /api/review-hub/stream?session=<sid>`（SSE）：新记录写入的瞬间推 `entry`，待审变化推 `pending`，别的会话推 `other`（只带聚合行需要的字段，不带参数内容）。
- 客户端 dock 成为唯一常驻的实时端点：一条 SSE 连接 + 断线时 3s 兜底轮询（`/entries?session=`、`/pending?session=`、`/stats`）。实时通，审批页与红点就是即时的。
- 宿主的 gzip 中间件显式跳过 `text/event-stream`，webserver 也没有响应超时；服务端每 20s 发一次心跳注释帧。

### 「审批」标签红点与新增分割线

- 未读口径：`ts > 上次查看` 且 `decidedBy` ∈ {ai, memory, external}（**人工与 fallback 不计**）。
- 有未读时标签变 `🔴 审批 (n)`（宿主 tab label 只能是字符串，所以用字形前缀，与 memory-evolve 同款），靠重注册这一个席位生效（id/order 不变，300ms 防抖）。
- 打开标签即归零；列表里在第一条"上次看过"的记录前插入 `—— 以上为新增审批 ——`。离开时把当前最大时间戳记为已看，之后到达的才算未读。

### 设置集中到「审批」标签页

- 五组分区：**审查 / 按请求方分档 / 自动放行 / 卡片与提示 / 数据**，外加导出与危险区。
- 所有布尔项改成主机同款**滑块**（32×18 胶囊 + 14px 圆钮，`role="switch"`），去掉"开/关"文字按钮。
- 每一项下面都有一句人话解释（例："审查超时（毫秒）—— 超时按「拿不准」处理，转人工"）。
- 数值项改成 `onBlur` 提交（打字不会每按一键写盘）。
- 插件页那张卡降级为一行指引："全部设置已移到「审批」标签页"。

### 视觉

- 一套配色变量（`.ah-dock / .ah-view` 上的 `--ah-ai-* / --ah-memory-* / --ah-human-*`），取主题自带的 `state-*-tertiary` 淡色：AI 淡绿、记忆更淡的蓝、人工更浅的黄。卡与徽章同源，改一行就能整体调。
- 卡片风格向 memory-evolve 靠：`bg-base` + `border-l2` + radius 10 + hover 描边；徽章 10–11px/600 的胶囊底。
- `查找` 从文字改成 16px 线性放大镜图标（`aria-label` 保留"查找"），与「轨迹」页搜索图标的线宽一致。

### 已知行为

- 多开两个窗口时各自维护"已看/基线"，红点可能不同步。
- 切换会话或红点变化会重注册审批页席位 → 页面重挂载、滚动位置复位（数据都在 store 里，不丢）。
- 宿主没有 `sidebarRight` / `inject` 时各能力自动降级（diff 回行内、卡片退回轮询）。

## 0.2.0 — FEEDBACK v2 全量

### 学习层（fingerprint v2）

- 新增 `KNOB_KEYS`（旋钮清单，**要删的键**）与 `EXACT_TOOLS`（工具级精确匹配豁免，第一版为空）。
- `normalizeFingerprintArgs()` / `fingerprintOf()`：参数能解析成普通对象时只删旋钮键，其余键排序后参与哈希；命令串等非 JSON 参数保持逐字节精确。
- 审计行新增 `fpMode` / `droppedKeys`；memory 行存归一化后的 `material` 原文，便于将来扩清单时重算迁移。
- 卡片在 `fpMode=normalized` 且真的删过键时显示「同类合并」。

**旋钮清单变更记录**（只进不出，每次加键都要写依据）：

| 时间 | 变更 | 依据 |
|---|---|---|
| 初次 | `limit, offset, page, size, count, max_results, maxResults, since, until, recent, timeout, timeoutMs, graceMs` | FEEDBACK §1：`plugin_manager list_plugins` 的 `limit:100/200` 被劈成两个 1/3 桶，永远攒不满 |

### AI 层

- 裁决缓存落盘 `ai-cache.json`（5s 写节流、环形 200、TTL 淘汰），启动载入未过期项。
- 缓存键 `agentKind + 指纹`（跨会话共享）；记忆计数仍按会话隔离。
- `maxTokens: 64` + 一次不带该选项的重试，失败即永久降级。
- stats 增加 `byModel` / `cacheSize` / `maxTokensSupported`，按审查器分车道。

### 界面

- 提示卡从 `conversation.composer.dock`（输入框内部下方）搬到 `conversation.input.dock`（输入框上方，order 30）。
- diff 从行内展开改到**右侧栏**独立 tab（`sidebar.right.pane.tab`），宿主无右侧栏时自动退回行内。
- 审查模型从自由文本改成下拉（跟随会话 + 已观察到的车道），枚举为空才退回文本框。
- toast 带 `AI 建议人工 · {risk} · {reason}`，且等审查器出结果后才弹。
- 审批页顶部新增审查器/缓存统计。

### 安全

- 新增 H0 硬风险类 `discard`（丢弃改动）：`git reset --hard` / `checkout -- <path>` / `checkout -f` / `restore` / `switch -f` / `stash drop|clear` / `branch -D`。`git checkout -b` 与软重置不算。

### 修复

- 客户端 store 是模块级单例：切会话时清空 `entries/cursor/stats/diff/revertArmed`，修掉"一个会话的审批页显示另一个会话的行"。
- `/diff` 的 after 改为取写前快照里由工具参数推出的内容（磁盘当前内容可能已被后续调用改掉），并回传 `drifted`。
- 撤销改成两次点击（3 秒内不点自动放弃）。

---

## 0.1.1 — 会话隔离与快照语义

- **审批页串会话修复**：客户端 `store` 是模块级单例，切会话时清空 `entries / cursor / stats / diff / revertArmed`。此前 A 会话的页面会显示 B 会话的记录，表头计数（按会话查）与列表（残留行）互相矛盾。
- **`/diff` 的 after 改口径**：从"读文件当前内容"改为"用写前快照里由工具参数推出的内容"（`write` 用 `content`，`edit`/`str_replace_editor` 用参数在 before 上做替换），并回传 `drifted` 标记——否则一次 `edit` 会因为文件后来被改过而显示成 `+10 / -648`。
- **撤销加确认**：`撤销此改动` 改为连点两次（3 秒不点自动放弃）。

## 0.1.0 — 单一实现初版

- 一个 answerer：`approval/request` 上唯一裁决者，归属写成事实（`ai / memory / human / external / fallback`），"外部抢答"用 300ms 阈值识别。
- 硬风险 L0（删除 / 凭据 / 远程执行 / 系统级 / 批量破坏 / 丢弃改动）：一律人工，永不学习、不送模型。
- 分层：L1 per-tool 策略 + 按请求方分档 → L2 记忆层（人工批满 N 次自动放行，**按会话隔离**）→ L3 AI 审查（**只能 allow / ask，没有否决权**）→ L4 人工。
- 界面：输入框上方提示卡、对话顶部「审批」时间线（查找 / 日期区间）、设置页插件卡片、toast、台账导出（CSV/JSON）。
- 写前快照（`tools/pre-execute`，只观察、永远 `next()`）+ 行内 diff + 撤销（投递指令给会话，插件自己不写文件）。
- 与旧四插件（`dsh-auto-review` / `（自用的）学习插件` / `（自用的）面板插件` / `dsh-approval-toast`）完全解耦，可独立安装。
