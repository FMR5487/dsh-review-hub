# FEEDBACK v2 — 明镜 (dsh-review-hub)

> 2026-11-07 由「装插件」会话整理（session-a48afe51-339b-4910-a119-ff3c1f4301cf），承接 FEEDBACK.md §1–§9，编号续起。
> 证据均为本机实测（台账/源码行号/test2.txt），执行归审批中心会话。

## §10 复制、行内展示与侧栏详情

### 10a 复制提取载荷，不复制参数 JSON

- 现状证据：台账 `argsText` 完整无截断（实测一条 1479 字符、无 `argsTextTruncated`），`client.js:785 commandOf()` 取的也是它——存储链路没毛病，问题在**语义**：复制/展示的是整坨 `{"command":…,"description":…,"justification":…,"sandbox_permissions":…}`，贴回终端不可执行、短命令时还是 `\n` 转义汤。
- 改法：`commandOf()` 先试 `JSON.parse(argsText)`——
  - bash 类（ops_bash/bash）取 `.command` **纯文本**（贴终端可直接执行）；
  - edit/write 类取 `.file_path`（贴路径有用，贴 JSON 没用）；
  - 解析失败或形状不认识：回退原文，行为不比现在差。
- 复制按钮、行内展示、搜索命中三处共用此结果（搜索现在也匹配 argsText 原文，会命中 description 噪音）。

### 10b 展开态 → 右侧栏「审批详情」tab

- 行右下角箭头（或整行点击）打开右侧栏新 tab「审批详情」，展示该条完整体：
  - `file_path` / 描述 / `justification` 分段；
  - `old_string` / `new_string` 各进 `<pre>`（真实换行还原、pre-wrap、超长滚动）；
  - 该行有写前快照时，直接复用现成 unified diff 视图（看"改了什么"比看参数原文有用）。
- 实现复用现有三件套（与 diff/设置/统计 tab 同构）：`sidebarRightTabs.register({id,kind,keepMounted,priority:'extension'})` + `sidebar.right.pane.tab` 席位 + `nav.openTab`。
- 宿主无右侧栏时回退现行内联展开，不留死按钮。
- 收益：列表行高恒定（短命令图标挤日期、长命令撑页两个历史问题一起消失），侧栏成为唯一详情面。
- 顺带统一：「铅笔（改动）」本就打开 diff tab——箭头与铅笔可合并为同一入口（详情 tab 内含描述 + diff），行尾少一枚图标。

## §11 人工卡位置：从"摆放对齐"改"嵌入宿主插槽"

- 钥匙（test2.txt，用户 F12 抓取）：宿主审批卡的命令区内有一个**空的子席位**：
  `Zf6DNq_command > div[data-slot="conversation.approval.detail"]`
- 改法：AdviceBand 注册进 `conversation.approval.detail` 子席位（scope session），AI 建议条直接渲染进原生卡内部——位置问题从"对齐"变成"不存在"。
- 安全网：注册包 try/catch，失败回落现行 input.dock 摆放（保留为 fallback，不删）。
- dock 的 pending 卡只在**无原生面板在场**时显示（焦点在别的窗口/宿主面板未接管时），避免同屏两张卡。
- 锚点选择器用 `data-approval-key`（宿主属性，比 hash 类名 `Zf6DNq_*` 稳定）。
- **翻案注记**：当年撤掉 approval.detail 席位注册是因为 web boot 崩溃（"1 entry did not activate"），但 00:21 那次日志真因是**包名撞 duplicate factory registration**（宿主按包名定 client bundle id，loader id 'approval-hub' vs 包名 dsh-approval-hub），不是席位有毒。包名问题后来已统一修掉，此路现在是干净的。

## §12 diff 侧栏页去掉「收起」按钮

- `renderDiff` 动作行里 `t('diff.close')` 那颗整删——切换/关闭走 tab 本身。
- `store.diff=null` 的清理逻辑保留在 tab 关闭/切换路径里，别把状态残留带出来。

## §13 diff 加载期间不渲染「撤销此改动」

- 现状证据：动作行在 `state.loading` 判定**之前**渲染（撤销+收起先出现，"加载中"提示在后），用户在内容未落地时可以点撤销。
- 改法：loading 只画提示行；动作行等数据落地且 `ok===true` 才出现；失败态（no-snapshot/binary/too-large/failed）同样不给撤销按钮。

## §14 卡片底色 = 输入框底色，彩色只留包边

- 废除 0.4.10 写死的 `--ah-card-bg: #2c2c2e` 与各卡 color-mix 淡底（写死色在浅色主题下会翻车，且与输入框仍差一点）。
- 底色取宿主 composer 输入框的实际背景（优先宿主 CSS 变量，取不到运行时 `getComputedStyle` 测量输入框元素）。
- 四类色调（AI 绿 / 记忆蓝 / 待审 `#f7ad31` / 高危红）只保留**边框包边**（border + 必要时 1px 外发光），底色统一。
- 效果：浅色/深色主题自动跟随，卡片与输入区融为一体、靠包边区分。

## §15 新设置

## §15a 新设置：指纹忽略 justification（`fpIgnoreJustification`，默认 false）

- 背景（bug① 续）：0.4.17 已把 `description` 进 KNOB_KEYS，`justification` 有意保留——"提权理由是人批准前要读的证据，不同理由必须分开"。该取舍合理，但意味着同命令不同理由的操作永远累计不到阈值。把它做成设置，让用户自己选。
- 行为：
  - **关（默认，= 现行为）**：justification 参与指纹，理由不同=不同操作、分开计数；
  - **开**：justification 进剔除名单，同命令不管理由怎么写都算同一操作、可累计到 threshold 自动放行。
- 备注文案（设置页直接可用）：
  > 关闭（默认）：每次审批填写的「理由」算作操作的一部分——理由不同就当作不同操作，分开累计次数。因为「提权理由」是你批准前要读的证据。开启：同一条命令不管理由怎么写都算同一个操作、累计放行。不确定就保持关闭。
- 实现提示：memory 行已存 `material`（store.js:250 注释预告过"未来 KNOB_KEYS 变化可重算"），开/关切换时可复用该机制重算既有计数；zh/en 键成对。

## §15b 新设置：自动展开描述
- 行为：
  - **关（默认，= 现行为）**：不展开描述。
  - **开**：展开描述。

## §16 观察记录（非工单）

- 重启（11-07 13:03 宿主 0.2.2-rc.1）后台账 17 行：`aiSource=unparsed` 归零——0.4.17 的 verdict 解析加固实测有效 ✓。
- 13:21:56 一条 `aiSource=error`（空理由）：发生在 ops 切换批次进行中，疑似 reviewerModel 当时解析到旧车道/服务瞬断。若后续复现，查 `review.js` 的 error 分支是否把 `provider/model` 记进行里（现在只有 aiSource=error，无诊断信息可查）。
