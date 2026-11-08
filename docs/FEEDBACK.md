# FEEDBACK — fingerprint v2：记忆计数被"翻页旋钮"劈成两半

> 交接对象：dsh-review-hub 实现会话。
> 依据：真实审批记录（11-05 00:32–00:33 三条 plugin_manager）+ store.js:92-106 / index.js:143-154 走查。

## 1. 现象（用户截图实证）

三条审批记录：

```
00:32:14  plugin_manager {"action":"list_plugins","limit":100}   人工通过 · 记忆 1/3
00:33:20  plugin_manager {"action":"list_plugins","limit":200}   人工通过 · 记忆 1/3
00:33:35  plugin_manager {"action":"list_plugins","limit":100}   人工通过 · 记忆 2/3
```

`limit:100` 两次正确合并（1/3→2/3），`limit:200` 被判成独立指纹从 1/3 另起。
两个桶都永远攒不满 threshold=3 → 用户观感"学习是死的"。

## 2. 根因

`store.js` 的 `fingerprint(toolName, argsText)` = `sha1(toolName + \0 + shrinkPaths(argsText))`——
只做路径压缩，参数**逐字节精确匹配**。分页/超时类旋钮（limit/offset/timeout）被当成语义的一部分。

## 3. 方案：fingerprint v2 = 旋钮剥离（确定性，非 AI 归组）

新增 `normalizeFingerprintArgs(toolName, argsText)`：

- argsText 能 `JSON.parse` 成普通对象时，**只删除旋钮清单（KNOB_KEYS）里的键**，其余键一律参与哈希；然后稳定序列化（键排序）作为指纹材料；
- 解析不动（shell 命令字符串等）→ 保持现状精确匹配；
- **命名纪律：全文不许出现"白名单/黑名单"这两个词**——方向性一读就丢。清单叫 `KNOB_KEYS`（旋钮清单），语义叫"删除旋钮"，反向方案叫"只保留语义清单"（本方案**不采用**，见 §3.5 理由）。
- 旋钮清单只进不出，第一版定死：

```
KNOB_KEYS = limit, offset, page, size, count, max_results, maxResults,
            since, until, recent, timeout, timeoutMs, graceMs
```

**方向性铁律（写进注释）**：清单是"要删的键"，不是"要留的键"。
没见过的键 → **默认保留 → 默认不合并 → 最坏结果只是多弹一次窗**。
反过来（只留认识的语义键）会让没见过的键默认被删、默认合并，
`model` / `sandbox_permissions` / `target` 一旦漏在名单外就是"你没批过的操作被自动放行"。
两种失败的代价不对称：漏合并= annoyance，误合并=安全破口。

**安全边界（必须写进注释和测试）**：

1. 语义字段永不移除：`command / target / path / file_path / url / action / name / query / op`。
   → `install_bundle@ego-browser` 与 `install_bundle@别的包` 不合并；`ops_bash` 每条命令各自计数。
2. L0 硬风险判定继续用**原始 argsText**（index.js 现状就是 classify 在先，fp 在后，别改顺序）。
3. 审计行新增 `fpMode: 'normalized' | 'exact'`；memory 行存归一化后的 `material` 原文，
   将来扩清单可重算迁移，不必从 0 再学。
4. 卡片 chip 显示「记忆 n/3 · 同类合并」（fpMode=normalized 时），让合并可见。

### 3.5 为什么不做反向方案（只保留语义清单）

反向 = 认识什么留什么，没见过的键默认删掉、默认合并。旋钮是**小而闭**的集合（翻页/取数/超时，
十几个键十年不变），语义是**大而开**的集合（每个新工具新参数都可能是语义）。让方案去枚举闭集可行，
枚举开集必漏，漏的那个键就是误合并破口。典型反例：`sandbox_permissions` 不在"语义清单"里时，
`{command:"pnpm install", sandbox_permissions:"workspace-write"}`（批过）与
`{…:"danger-full-access"}`（没批过）归一后同指纹 → 自动放行。
**结论：删除动作只能作用于确认无害的键，未知键一律保留。**

### 3.6 增强一：工具级精确匹配豁免（EXACT_TOOLS）

旋钮清单管"哪些键删"，豁免清单管"哪些工具一个键都不删"：

```
EXACT_TOOLS = []   // 第一版为空；默认所有工具都走旋钮剥离
```

用途：某工具的旋钮名其实是语义（假想 `resize_window` 的 `size`），把它加进 EXACT_TOOLS，
该工具整体退回逐字节精确匹配。方向同样是保守的：默认不豁免，出问题加一个锁死一个。
实现只需在 normalizeFingerprintArgs 开头 `if (EXACT_TOOLS.has(toolName)) return { text: argsText, mode: 'exact' }`。

### 3.7 增强二：删除留痕 + 证据晋升通道

- 归一化时把实际删掉的键记入审计行：`droppedKeys: ["limit"]`（fpMode=normalized 时才有）。
- 运营节奏：观察真实"分裂记录"（同 action、不同桶、都攒不满）→ 确认那个键确实是旋钮 →
  加进 KNOB_KEYS → 用 memory 行存的 material 重算指纹迁移计数，不从 0 再学。
- 清单每次变更在 CHANGELOG 记一行（加了什么键、依据是哪条分裂记录），只进不出。

## 4. selftest 用例（4 条起步）

1. 上面三条截图记录 → 归一后同一指纹，计数 1/3→2/3→3/3，第 4 次 memory 放行
2. `plugin_manager` install_bundle 不同 target → 两个指纹，互不计数
3. `ops_bash` 同 command 不同 timeoutMs → 合并；不同 command → 不合并
4. `rm -rf` 带任意旋钮 → hardRisk 仍命中、tier=human（学习层碰不到）

## 5. 新需求（用户提出）：设置里的「AI 审查模型」改成可选项

现状：store.js 已有 `reviewerModel`（自由文本，手打 `provider/model`，空=跟随会话；
client.js:1113 是纯 input）。问题：打错不报错、静默回落；用户不知道有哪些可选。

改成**下拉选择**：

- 宿主半身新增路由 `GET /api/review-hub/models`：枚举宿主可用模型
  （走 dsh-llm 的 provider/model 目录；拿不到时返回空数组）。
- 客户端设置区把 input 换成 `<select>`：
  - 第一项固定 **「跟随会话（默认）」**（值=空串，行为不变：从 request/header 倒找实际车道）
  - 其余项 = 枚举结果，显示 `provider/model`，**免费/低费车道加标注**（能拿到价格元数据就标 ¥，
    拿不到标 `free-lane?`，拿不到不编造）
  - 枚举为空时**降级回文本框**（不阻塞设置），placeholder 提示 `provider/model` 格式
- 校验：保存时值必须 `provider/model` 形状或空串，否则不写入；review.js 现有
  `route.provider/model` 覆盖逻辑不动。
- 建议默认值引导（README + 卡片提示语）：审查器是"读一段摘要、答一个 JSON"的小任务，
  **推荐挂在免费车道/便宜模型上**，别占主力会话——这条与 §6 直接相关。

## 6. AI 审批的 token 消耗：现状 + 四项优化

先摆量级（review.js 实测形状）：每次裁决 = system ≈120 tokens + 证据（摘要 ≤240 字符 +
几行元数据）≈150–350 tokens + 输出 ≈30 tokens。**一次 ≈300–500 tokens，不贵但不为零。**
最大的省钱机制其实已经存在：**记忆层满 3 次后该操作不再调模型**——AI 只处理"新面孔"。
以下四项按收益排：

1. **裁决缓存落盘**（现在 cache 是内存 Map，重启全丢）：
   `~/.dsh/storages/review-hub/ai-cache.json`，条目 `{cacheKey, verdict, at}`，
   写节流（≥5s 一次 flush）、上限 200 条环形、启动时载入未过期项。
   价值：宿主重启频繁（本机常态），每次重启后首批"新操作"都会重新花一遍模型钱。
2. **缓存键跨会话化**：现在 key=`sessionId\0fp`，同一工具同一参数换个会话就重判。
   改为 `agentKind\0fp`（agentKind 参与键——不同档位策略本就不同），
   跨会话共享裁决。**注意**：这只影响 AI 缓存，不影响记忆计数（记忆必须保持会话隔离，
   那是防"跨会话串票"的设计，别顺手一起改）。
3. **输出封顶**：llm 请求带 `maxTokens: 64`（宿主 seam 支持的话）——裁决 JSON ≈30 tokens，
   防止模型跑偏长篇大论把预算吃掉；seam 不支持就跳过，不强造。
4. **缓存命中/未命中上卡片**：stats 已有 cacheHits，加一行「AI 缓存命中 n / 调用 m」，
   让"这功能花了多少"可见——用户能看见，才不会怀疑它在暗烧。

不建议做的：批量合并多个 pending 到一次调用（破坏逐条归属与超时语义）；
静态"安全工具免审清单"直接绕过审批（那是记忆机制的职责，绕开人批等于新增放行通道）。

## 7. AI 拒绝理由透传给正在批的人（用户提出）

现状（代码走查）：理由其实已经落库——index.js:172 `aiNote={risk,reason,source,asked}`、
:231 `finished.aiReason`，时间线点开可见。**断在"请求打到用户面前那一刻"的展示**：

- 原生审批面板是宿主的，改不了，它不知道 AI 刚判了 ask 和理由；
- toast（client.js:358 noticePending）body 没带 aiReason；
- 黄卡 pendingCard 默认关，开着也不含 AI 理由。

改法（两个口 + 一条措辞红线）：

1. **toast body 带理由**：`AI 建议人工 · {risk} · {aiReason}`（aiReason 缺失时退回现有文案）。
   一行改动，收益最大——用户实际靠 toast 批。
2. **黄卡文案模板**（pendingCard=true 时）：`AI 已审：{risk} · {aiReason}` + 批准/拒绝按钮。
   开关默认值维持 false 不变，但模板先定好。
3. **措辞红线**：所有展示位写「AI 建议」不写「AI 决定」——AI 只有 allow/ask，
   ask 的语义是"拿不准，交给你"，不是"否决"。防止用户把 ask 误读为挡箭牌。

## 8. 审查模型选型：影子模式统计（用户提出"不同模型影响多大"）

结构性结论（先于任何数据成立）：
- 决策空间只有 allow|ask + deny 判无效转人工 + 硬风险 L0 先拦 → **换任何模型都造不出
  "误拒"和"危险放行"，最坏退化是 ask 率高到 AI 层形同虚设**；temperature 0 已锁。
- 模型间真实差异 = ask 率与理由质量：旗舰能读"理由说读文件、命令却是 rm"的
  不一致性；中档容易漏"事小权限大"的越权信号；小模型两极（全 ask 或格式敏感 parse 失败）。
  两种失败模式都良性（转人工），但要防"AI 层白开"。

实现（小改动）：
1. stats 已有 calls/allows/asks/fallbacks/cacheHits → 卡片加一行
   「审查器：{provider/model} · 本周 allow n / ask m / 兜底 k」。
2. **按审查器分别统计**：stats 键从全局改成 `reviewerModel||'session-lane'`，
   换模型跑一周直接对比 ask 率——ask 率 >80% 的模型等于没审；allow 率异常高要抽查。
3. 选型建议写进 README：审查器与主力会话**不同源**（避免"自己审自己互相给面子"），
   便宜清醒车道优先；配合 §6 落盘缓存，边际成本趋零。
4. caveman/ponytail 与 hub 绝缘（RTK 只挂 OFM adapter，hub 走宿主 llm seam），
   实现方不需要为审批器考虑文风压制，也**不要**给审查器输出做任何再压缩——
   30 token 的 JSON 已经是最小形态。

## 9. 顺带

- moon09300731 式"AI 语义同类验证"记为远期选项（RESEARCH.md 追加一行即可），第一版不引入——
  确定性方案可审计、零 token 成本、不会误合。
- 改完与 dsh-raccoon-care 的 FEEDBACK.md 事项（假 failed + 手动签到按钮）攒同一次重启。
