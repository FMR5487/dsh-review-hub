window.__ModuleLoader__.load({
  // MUST equal the package name: dsh-client-modules keys the factory by it and
  // throws "loaded without registering <package>" (and a duplicate registration)
  // when a bundle registers anything else — that error takes the whole web boot down.
  id: 'dsh-review-hub',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // ─── 区块索引（改代码前先定位区块，再改；顺序即依赖顺序）────────────
    // 01 · 常量与语言字典   NS / 确认时长 / 中英两份 locale 文案
    // 02 · 纯函数           指纹展示、记忆文案、理由分段、车道拆词、时间戳…（无 DOM、无 React）
    // 03 · 状态与接口       store 单例、HTTP/SSE、load* 系列、订阅与通知
    // 04 · 样式             单一 <style> 文本数组（颜色一律走宿主变量）
    // 05 · 组件            HintBar / SettingsPanel / ApprovalPage / ConfigCard / MemoryBody / StatsPanel
    // 06 · 导出             loader 契约（id 必须等于包名）+ __test 钩子
    // ────────────────────────────────────────────────────────────────

    const NS = 'dsh-review-hub';
    const CONFIRM_RESET_MS = 6000;
    /** Undo arms on the first click and gives up on its own: a stray click must not lose a file. */
    const REVERT_CONFIRM_MS = 3000;
    const CLEAR_CLICKS = 3;
    const MEMORY_CLEAR_CLICKS = 2;

    const zh = {
      'tab': '审批',
      'dock.ai': 'AI 通过',
      'dock.memory': '记忆通过',
      'dock.ask': 'AI 拿不准，已转人工',
      'dock.external': '由外部插件裁决',
      'dock.pending': '等待人工审批',
      'dock.pendingAi': 'AI 建议人工 · {risk} · {reason}',
      'dock.pendingLine': '等待审批中 {time}',
      'dock.pendingDanger': '命中 L0 硬风险（{rule}）：不送 AI、不计记忆，直接交给你',
      'dock.dismiss': '关闭',
      'bar.strip': '共 {total} 条 · 放行 {allow} · 拒绝 {deny} · 取消 {cancelled} · 不可用 {unavailable}',
      'bar.total': '共 {n} 条',
      'bar.allow': '放行 {n}',
      'bar.deny': '拒绝 {n}',
      'bar.cancelled': '取消 {n}',
      'bar.unavailable': '不可用 {n}',
      'bar.search': '查找',
      'bar.searchFiltered': '已筛选 · 点开查看筛选条件',
      'bar.memory': '已记忆 {n} 条',
      'bar.settings': '设置',
      'filter.text': '搜索操作、目录、理由…',
      'filter.from': '起始时间',
      'filter.to': '结束时间',
      'filter.count': '筛出 {n} 条',
      'filter.countNone': '筛出 - 条',
      'filter.countShort': '{n} 条',
      'filter.clear': '清除',
      'filter.tool': '所有工具',
      'empty.session': '本会话还没有审批记录',
      'empty.filter': '没有匹配的记录',
      'empty.memory': '还没有记忆的操作：同一操作人工批准满阈值后会自动放行',
      'chip.aiRejected': 'AI 打回',
      'chip.human': '人工通过',
      'chip.ai': 'AI 通过',
      'chip.memory': '记忆通过',
      'chip.humanDeny': '人工拒绝',
      'chip.aiDeny': 'AI 拒绝',
      'chip.rejected': '拒绝',
      'chip.cancelled': '已取消',
      'chip.fallback': '不可用',
      'chip.external': '外部裁决',
      'memory.progress': '记忆 {count}/{threshold} 次',
      'memory.progressLead': '记忆',
      'memory.mergedPrefix': '合并',
      'memory.progressUnit': '次',
      'memory.fullMerged': '合并记忆已满',
      'memory.count': '记忆 {n} 次',
      'memory.remove': '删除',
      'memory.clear': '清空记忆',
      'memory.tabTitle': '明镜 · 记忆',
      'bar.memoryOpen': '记忆',
      'memory.search': '搜索记忆',
      'memory.removeConfirm': '确认移除',
      'memory.emptySearch': '没有匹配的记忆',
      'memory.groupMeta': '{n} 条 · 最后命中 {time}',
      'memory.hits': '命中 {n} 次 · 最后命中 {time}',
      'memory.groupHits': '{n} 条 · 命中 {hits} 次 · 最后命中 {time}',
      'memory.groupCount': '{n} 条',
      'memory.merged': '合并 {n} 条',
      'setting.fileFingerprint': '允许记忆同文件不同修改（全局）',
      'setting.fileFingerprintNote': '开启：同一文件的任意修改将会合并成一条记忆，学满即自动放行。关闭：用记忆页每行的开关逐文件放行。',
      'memory.allTools': '所有工具',
      'memory.files': '按文件',
      'memory.filesNone': '还没有写过文件的审批',
      'memory.filesStale': '文件统计要重启宿主才会出现（这一版只加了界面）',
      'memory.fileApproved': '已批准 {n} 次',
      'memory.fileAuto': '自动放行',
      'memory.fileAutoHint': '开启后，这个文件累计批准满阈值就自动放行。高危操作永远例外。',
      'memory.canArm': '可在「明镜 · 记忆」中开启自动放行',
      'memory.canArmShort': '可开启自动放行',
      'memory.full': '记忆已满',
      'memory.confirm': '再点 {n} 次确认',
      'diff.change': '改动',
      'diff.title': '明镜 · 改动',
      'diff.none': '在审批列表里点「改动」，这里会显示那一次调用的 diff',
      'diff.stats': '+{add} / -{del} 行变更 · {unchanged} 行未变',
      'diff.loading': '正在读取改动…',
      'diff.noSnapshot': '这次审批没有留下快照（插件安装前、或该工具不建快照）',
      'diff.noAfter': '文件已经不在原处，且没有记录改动后内容',
      'diff.binary': '二进制文件，无法显示文本 diff',
      'diff.tooLarge': '文件过大，未保存快照',
      'diff.drifted': '该文件在这次改动之后又变过，上面显示的是这次改动本身',
      'diff.failed': '读取失败',
      'diff.revert': '撤销此改动',
      'diff.revertConfirm': '确认撤销？',
      'diff.reverted': '已把撤销指令投递给该会话',
      'diff.noAgent': '该会话当前没有可投递的 agent',
      'diff.close': '收起',
      'setting.title': '设置',
      'setting.close': '收起',
      'setting.ai': 'AI 审查',
      'setting.memory': '记忆自动通过',
      'setting.hint': '输入框上方提示',
      'setting.toast': '等待审批时弹通知',
      'setting.pendingCard': '等待审批时提示',
      'setting.aiNote': '关掉后每条审批都直接问你',
      'setting.aiNote2': '只有允许的工具会先给 AI，详见插件页高级设置',
      'setting.memoryNote': '同一操作批满阈值次数后自动放行（按会话隔离）',
      'setting.model': '审查模型',
      'setting.modelNote': '留空 = 跟随当前会话的车道；只会列出见过的车道',
      'setting.timeout': '审查超时（毫秒）',
      'setting.timeoutNote': '超时按「拿不准」处理，转人工',
      'setting.budget': '每轮审查上限',
      'setting.budgetNote': '一个回合最多调用几次模型',
      'setting.breaker': '熔断次数',
      'setting.breakerNote': '连续失败几次后暂停 AI 审查 5 分钟',
      'setting.threshold': '放行阈值（次）',
      'setting.thresholdNote': '人工批准这么多次之后自动放行',
      'setting.fpIgnoreJustification': '允许记忆忽略「理由」',
      'config.debugReview': '记录评审流（取证）',
      'config.debugReviewNote': '把模型返回的每个数据块的类型与字段名写进 review-probe.log（只记名字，不记值）。用来确认宿主是否透出 prompt-cache / token 用量，从而决定要不要做提示词前缀稳定化',
      'config.strictVerdict': '严格裁决协议',
      'config.strictVerdictNote': '只接受 {decision, risk, reason} 这一种形状：字段名、取值、风险等级有一个不合规就转人工（记为 unparsed）。默认关——中文小模型更容易因此多问人',
      'config.debugHeaders': '记录请求头（取证）',
    'config.debugHeadersNote': '把每个请求的 header 名与 cookie 名写进 http-probe.log（只记名字，不记值，最多 400 行）。用来确认写围栏该用哪个 cookie，平时保持关闭',
    'setting.hideKnobs': '隐藏无用旋钮',
      'setting.hideKnobsNote': '隐藏命令中如 limit、offset 等无关键值的显示（复制仍给完整命令）',
      'setting.autoExpand': '自动展开描述',
      'setting.autoExpandNote': '关闭（默认）：描述要手动点箭头才展开。开启：每条记录默认展开描述，点箭头仍可收起。',
      'setting.fpIgnoreJustificationNote': '关闭（默认）：每次填写的理由算作操作的一部分——理由不同就当作不同操作、分开累计次数，因为提权理由是你批准前要读的证据。开启：同一条命令不管理由怎么写都算同一个操作、可累计放行。不确定就保持关闭。',
      'setting.hintNote': '在输入框上方显示提示卡',
      'setting.pendingNote': '等待审批时显示提示卡',
      'setting.aiAdviceCard': '启用 AI 建议卡',
      'setting.aiAdviceCardNote': 'AI 给出理由时，在审批卡上方显示「AI 建议人工」的悬浮卡（关掉后只剩等待提示）',
      'setting.dangerCard': '启用高危提示卡',
      'setting.dangerCardNote': '命中 L0 硬风险时，用浅红卡片提醒这是危险操作',
      'setting.hintAi': 'AI 卡时长（毫秒）',
      'setting.hintAiNote': 'AI 审批通过的卡片持续时间；到点自动收起',
      'setting.hintMemory': '记忆卡时长（毫秒）',
      'setting.hintMemoryNote': '记忆通过的卡片持续时间；到点自动收起',
      'setting.hintPending': '等待审批卡时长（毫秒）',
      'setting.hintMsNote': '到点自动收起',
      'setting.hintPendingNote': '0 = 一直留着，直到审批完成',
      'setting.toastNote': '系统通知，需要浏览器授权',
      'setting.pollMs': '兜底轮询（毫秒）',
      'setting.pollNote': '只在实时连接断开时用它',
      'setting.maxEntries': '每会话保留条数',
      'setting.maxEntriesNote': '超出后丢最旧的',
      'setting.clearOnNote': '打开后才出现清空按钮',
      'settings.tabTitle': '明镜 · 设置',
      'stats.tabTitle': '明镜 · 统计',
      'bar.stats': '审批统计',
      'stats.totals': '审批合计',
      'stats.lanes': 'AI 调用情况',
      'stats.reviewerInline': 'allow {allow} / ask {ask} / 兜底 {fallback}',
      'stats.cacheLine': '审批缓存 {total} 条 · 命中 {hits} 次',
      'stats.tokensLine': 'Token 总用量 输入 {input} · 输出 {output} · 缓存读取 {cached}',
      'stats.tokens': 'Token',
      'stats.hitRate': '缓存命中',
      'stats.lane': '车道',
      'stats.calls': '调用',
      'stats.allow': 'allow',
      'stats.ask': 'ask',
      'stats.fallback': '兜底',
      'stats.cache': '审批缓存命中',
      'setting.secReview': '审查',
      'setting.secAgent': '按请求方分档',
      'setting.agent': '谁能用 AI 审查',
      'setting.agentNote': '子代理/定时/看板默认更严：它们替你做的事更多',
      'setting.secMemory': '自动放行',
      'setting.secCard': 'UI与提示卡',
      'setting.secData': '数据',
      'list.divider': '以上为新增审批',
      'row.showReason': '展开详情',
      'row.hideReason': '收起详情',
      'row.aiReject': 'AI 打回理由',
      'row.aiAllow': 'AI 通过理由',
      'row.risk': '风险',
      'risk.high': '高',
      'risk.medium': '中',
      'risk.low': '低',
      'risk.unknown': '未知',
      'row.copy': '复制命令',
      'row.waiting': '正在等待人工审批…',
      'row.highRisk': '高危',
      'band.advice': 'AI 建议人工 · {risk} · {reason}',
      'band.hardRisk': '高危操作，未进 AI 审查（命中 {rule}）',
      'band.noAdvice': 'AI 未给出意见，请自行判断',
      'dock.copy': '复制',
      'dock.copied': '已复制',
      'dock.copyFailed': '复制失败',
      'dock.otherChip': '其他会话',
      'dock.otherAi': 'AI通过 {n}',
      'dock.otherMemory': '记忆通过 {n}',
      'dock.otherHuman': '人工通过 {n}',
      'dock.otherWaitingTitle': '其他会话等待人工审批',
      'dock.otherWaitingOne': '{title}',
      'dock.otherWaitingAgainOne': '仍未处理：{title}',
      'dock.otherWaitingBody': '{title}（{n} 条）',
      'dock.otherWaitingAgainBody': '仍未处理：{title}（{n} 条）',
      'config.motto': 'AI 是灯下献策的幕僚，镜子只负责把每道审批照得清清楚楚。',
      'dock.otherWaitChip': '等待审批 {n}',
      'config.secAdvanced': '高级设置（不要乱改）',
      'config.advancedWarn': '下面这些会改变失败行为与性能，没有明确理由请不要动',
      'config.agentNote': '子代理/定时/看板默认更严：它们替你做的事更多',
      'config.clearOn': '启用「清空历史」',
      'config.clearOnNote': '打开后审批页才出现清空按钮（仍需连点三次）',
      'config.open': '打开审批页',
      'setting.grant': '授权浏览器通知',
      'setting.granted': '通知已授权',
      'setting.export': '导出台账',
      'setting.exportAll': '导出全部会话',
      'setting.csv': 'CSV',
      'setting.json': 'JSON',
      'setting.danger': '危险操作',
      'setting.clear': '清空历史（仅当前会话）',
      'setting.clearOn': '启用「清空历史」',
      'setting.saved': '已保存',
      'setting.failed': '保存失败',
      'setting.clearDone': '已清空',
      'config.pollMs': '轮询间隔（毫秒）',
      'config.maxEntries': '每会话条目上限',
      'config.timeout': 'AI 超时（毫秒）',
      'config.budget': '每分钟审查上限',
      'config.breaker': '连续失败熔断阈值',
      'config.model': '审查模型（留空=会话默认）',
      'config.modelAuto': '跟随会话（默认）',
      'config.modelEmpty': '还没观察到可用车道，先手填 provider/model',
      'config.modelLocal': '不与其他会话同步',
      'config.modelLocalNote': '开启后本会话的模型选择独立于其他会话',
      'model.none': '—',
      'model.next': '下次审批：{lane}',
      'model.nextNone': '下次审批：跟随会话（本会话还没记录到车道）',
      'model.last': '上次审批：{lane}',
      'model.refresh': '刷新模型目录',
      'model.skipped': '{n} 个 provider 没返回目录（缺凭据或超时），已跳过',
      'preview.kindPending': '等待审批',
      'preview.kindReviewing': 'AI 审阅中',
      'row.aiNoVerdict': 'AI 未给出结论',
      'row.aiSkipLabel': '未送 AI：',
      'dock.pendingSkipped': '未送 AI 审查（{why}）—— 由你判断',
      'preview.kindTimeout': 'AI 超时/无结论',
      'preview.owner': '开关：{name}',
      'preview.kindDanger': '高危',
      'preview.sampleHint': '以上是样例；下面是本会话实时',
      'preview.floatTry': '试一下悬浮卡',
      'preview.floatTryDanger': '试一下高危悬浮卡',
      'preview.floatHint': '点上面的按钮，对话区顶部居中会出现 12 秒的示例悬浮卡（真实审批时它就是给你看 AI 建议的那张，宿主审批框盖不住）。',
      'preview.floatShown': '示例已出现，12 秒后自动消失。',
      'preview.floatNoAnchor': '示例已出现，但还没量到对话列（先回对话页看一眼再回来点），现在按窗口居中预览，宽度也不对。',
      'preview.floatBlocked': '先把「输入框上方提示」和「等待审批时显示提示卡」这两个开关打开，浮层才有东西可显示。',
      'preview.floatHidden': '审批页正开着的时候浮层是隐藏的（列表已经显示了同样的内容），切到别的标签页再试。',
      'preview.floatReason': '预览：一条样例命令的理由',
      'preview.floatAdvice': '预览：命令只读、范围明确，但这条操作还没在记忆里',
      'preview.recent': '本会话最近 6 条',
      'preview.pending': '待你审批',
      'preview.noPending': '当前没有待审',
      'dock.pendingReviewing': 'AI 正在审阅… 已 {sec}s {spin}\n可以先点按钮，你的决定不会被它的结论覆盖',
      'dock.pendingFailed': 'AI 审批超时，未给出结论 —— 请你判断',
      'config.promptAppend': '追加提示词（可为空）',
      'config.promptAppendNote': '会接在固定提示词之后。固定规则由程序强制执行，与本段冲突的部分一律忽略——这里只能加偏好，改不掉红线',
      'config.reviewerLocale': 'AI 理由语言',
      'config.reviewerLocaleNote': '跟随界面 = 用你当前界面语言；也可强制中文 / English',
      'config.localeAuto': '跟随界面',
      'config.humanFirst': '交出决策权（毫秒）',
      'config.humanFirstNote': 'AI 超过这个时间没给结论，就先把人工选项摆出来；AI 之后返回的意见只记录、不改变决定。0 = 关闭',
      'config.reasonChars': 'AI 理由长度上限（字符）',
      'config.reasonCharsNote': '40–400，默认 80。中文理由通常比英文长，嫌理由太短就调大',
      'config.cacheTtl': 'AI 缓存过期（毫秒）',
      'config.cacheTtlNote': '600000 = 10 分钟；0 = 关闭缓存（每次都调模型）。缓存键跨会话共用：请求方档位 + 参数指纹。',
      'config.snapshotDays': '快照保留天数',
      'config.snapshotDaysNote': '0 = 一直保留（受每会话 64 条、最多 64 个会话的限制）；设成 N 天后，过期快照在下次启动时清理',
      'config.aiTools': '额外先交给 AI 的工具',
      'config.aiToolsNote': '逗号或换行分隔。内置默认（shell、只读文件与检索、只读网络、任务输出）已写死在代码里，这里只填要额外加进去的工具；write / edit 属记忆档，不受影响。',
      'config.aiToolsDeny': '不交给 AI 的工具（黑名单）',
      'config.aiToolsDenyNote': '逗号或换行分隔。写在这里的工具一律直接问你，连内置默认也会被盖掉；记忆档不受影响。',
      'config.agent': '按来源的 AI 档位',
      'config.save': '保存',
      'config.saved': '已保存',
      'config.failed': '保存失败',
      'config.loading': '载入中…',
    };

    const en = {
      'tab': 'Approvals',
      'dock.ai': 'AI passed',
      'dock.memory': 'Memory passed',
      'dock.ask': 'AI was unsure, asked the human',
      'dock.external': 'Decided by another plugin',
      'dock.pending': 'Waiting for a human',
      'dock.pendingAi': 'AI suggests a human · {risk} · {reason}',
      'dock.pendingLine': 'Awaiting approval since {time}',
      'dock.pendingDanger': 'Hit L0 hard risk ({rule}): not sent to the AI, never learned, straight to you',
      'dock.dismiss': 'Dismiss',
      'bar.strip': '{total} total · {allow} allowed · {deny} denied · {cancelled} cancelled · {unavailable} unavailable',
      'bar.total': '{n} total',
      'bar.allow': '{n} allowed',
      'bar.deny': '{n} denied',
      'bar.cancelled': '{n} cancelled',
      'bar.unavailable': '{n} unavailable',
      'bar.search': 'Find',
      'bar.searchFiltered': 'Filtered · open to see the conditions',
      'bar.memory': 'Memorized {n}',
      'bar.settings': 'Settings',
      'filter.text': 'Search tool, path, reason…',
      'filter.from': 'From',
      'filter.to': 'To',
      'filter.count': '{n} matched',
      'filter.countNone': 'matched -',
      'filter.countShort': '{n}',
      'filter.clear': 'Clear',
      'filter.tool': 'All tools',
      'empty.session': 'No approvals in this session yet',
      'empty.filter': 'Nothing matches',
      'empty.memory': 'Nothing learned yet: an operation auto-passes after enough human approvals',
      'chip.aiRejected': 'AI escalated',
      'chip.human': 'Human approved',
      'chip.ai': 'AI passed',
      'chip.memory': 'Memory passed',
      'chip.humanDeny': 'Human denied',
      'chip.aiDeny': 'AI denied',
      'chip.rejected': 'Denied',
      'chip.cancelled': 'Cancelled',
      'chip.fallback': 'Unavailable',
      'chip.external': 'External',
      'memory.progress': 'memory {count}/{threshold}',
      'memory.progressLead': 'memory',
      'memory.mergedPrefix': 'merged ',
      'memory.progressUnit': '',
      'memory.fullMerged': 'merged memory full',
      'memory.count': 'memory {n}',
      'memory.remove': 'Remove',
      'memory.clear': 'Clear memory',
      'memory.tabTitle': 'MingJing · Memory',
      'bar.memoryOpen': 'Memory',
      'memory.search': 'Search memory',
      'memory.removeConfirm': 'Confirm',
      'memory.emptySearch': 'No memory matches that',
      'memory.groupMeta': '{n} · last hit {time}',
      'memory.hits': 'hit {n} times · last {time}',
      'memory.groupHits': '{n} · hit {hits} times · last {time}',
      'memory.groupCount': '{n}',
      'memory.merged': '{n} merged',
      'setting.fileFingerprint': 'Learn across changes to one file (global)',
      'setting.fileFingerprintNote': 'On: any change to one file becomes a single memory entry and auto-passes once learned. Off: use the per-file switches in the memory page.',
      'memory.allTools': 'All tools',
      'memory.files': 'By file',
      'memory.filesNone': 'No file-writing approval yet',
      'memory.filesStale': 'File stats need a host restart (this build only added the UI)',
      'memory.fileApproved': '{n} approvals',
      'memory.fileAuto': 'Auto-pass',
      'memory.fileAutoHint': 'Once on, this file auto-passes after the threshold. Hard-risk calls stay manual.',
      'memory.canArm': 'auto-pass can be enabled in MingJing · Memory',
      'memory.canArmShort': 'auto-pass available',
      'memory.full': 'learned',
      'memory.confirm': 'Click {n} more',
      'diff.change': 'Diff',
      'diff.title': 'MingJing · Change',
      'diff.none': 'Pick "Change" on a row: the diff of that call shows up here',
      'diff.stats': '+{add} / -{del} changed · {unchanged} unchanged',
      'diff.loading': 'Reading the change…',
      'diff.noSnapshot': 'No snapshot for this approval (older than the plugin, or the tool keeps none)',
      'diff.noAfter': 'The file is gone and the written content was not recorded',
      'diff.binary': 'Binary file: no text diff',
      'diff.tooLarge': 'File too large, no snapshot kept',
      'diff.drifted': 'This file changed again after this call; the diff above is this call own change',
      'diff.failed': 'Failed to read',
      'diff.revert': 'Undo this change',
      'diff.revertConfirm': 'Undo?',
      'diff.reverted': 'Undo instruction delivered to the session',
      'diff.noAgent': 'This session has no agent to deliver to',
      'diff.close': 'Hide',
      'setting.title': 'Settings',
      'setting.close': 'Hide',
      'setting.ai': 'AI review',
      'setting.memory': 'Memory auto-pass',
      'setting.hint': 'Hint above the composer',
      'setting.toast': 'Notify when a human is needed',
      'setting.pendingCard': 'Hint while waiting',
      'setting.aiNote': 'Off means every approval goes straight to you',
      'setting.aiNote2': 'Only the allowed tools go to the AI first; see Advanced in the plugin page',
      'setting.memoryNote': 'Auto-approve after N human approvals of the same operation (per session)',
      'setting.model': 'Reviewer model',
      'setting.modelNote': 'Blank = follow the session lane; only lanes seen are listed',
      'setting.timeout': 'Review timeout (ms)',
      'setting.timeoutNote': 'A timeout counts as unsure and falls back to you',
      'setting.budget': 'Reviews per turn',
      'setting.budgetNote': 'Hard cap on model calls in one turn',
      'setting.breaker': 'Breaker threshold',
      'setting.breakerNote': 'Consecutive failures before the reviewer pauses for 5 minutes',
      'setting.threshold': 'Auto-approve after (times)',
      'setting.thresholdNote': 'Human approvals needed before the operation passes on its own',
      'setting.fpIgnoreJustification': 'Let memory ignore the reason',
      'config.debugReview': 'Record the review stream (forensics)',
      'config.debugReviewNote': 'Writes the type and field names of every model chunk into review-probe.log (names only, never values). It answers whether the host exposes prompt-cache or token usage, which decides if prompt-prefix stabilisation is worth doing',
      'config.strictVerdict': 'Strict verdict protocol',
      'config.strictVerdictNote': 'Accepts one shape only — {decision, risk, reason}: a wrong field name, value or risk level goes to a human (recorded as unparsed). Off by default; small models end up asking more often',
      'config.debugHeaders': 'Record request headers (forensics)',
    'config.debugHeadersNote': 'Writes each request\'s header and cookie names into http-probe.log (names only, never values, 400-line cap). Use it to pick the write-fence cookie; leave it off otherwise',
    'setting.hideKnobs': 'Hide knob arguments',
      'setting.hideKnobsNote': 'Hides limit, offset and friends from the displayed command (copy still gives the full one)',
      'setting.autoExpand': 'Expand descriptions automatically',
      'setting.autoExpandNote': 'Off (default): the description opens when you click the arrow. On: every row starts expanded, and the arrow still collapses it.',
      'setting.fpIgnoreJustificationNote': 'Off (default): the reason you type counts as part of the operation, so different reasons are different operations with separate counts — the escalation reason is the evidence you read before granting. On: the same command counts as one operation no matter what the reason says, so it can reach the auto-approve threshold. Leave it off if unsure.',
      'setting.hintNote': 'Show hint cards above the input',
      'setting.pendingNote': 'Show a hint card while waiting',
      'setting.aiAdviceCard': 'Show the AI advice card',
      'setting.aiAdviceCardNote': 'When the reviewer gives a reason, float an “AI suggests a human” card above the approval card (off = only the waiting hint remains)',
      'setting.dangerCard': 'Show the high-risk card',
      'setting.dangerCardNote': 'When L0 hard risk hits and the reviewer has no reason, flag it with a pale red card',
      'setting.hintAi': 'AI card lifetime (ms)',
      'setting.hintAiNote': 'How long the “AI passed” card stays; it collapses when the time is up',
      'setting.hintMemory': 'Memory card lifetime (ms)',
      'setting.hintMemoryNote': 'How long the “memory passed” card stays; it collapses when the time is up',
      'setting.hintPending': 'Waiting card lifetime (ms)',
      'setting.hintMsNote': 'Collapses by itself when the time is up',
      'setting.hintPendingNote': '0 = stays until the approval is done',
      'setting.toastNote': 'System notification; needs browser permission',
      'setting.pollMs': 'Fallback poll (ms)',
      'setting.pollNote': 'Only used while the live stream is down',
      'setting.maxEntries': 'Rows kept per session',
      'setting.maxEntriesNote': 'Oldest rows are dropped past this',
      'setting.clearOnNote': 'The clear button appears only when this is on',
      'settings.tabTitle': 'MingJing · Settings',
      'stats.tabTitle': 'MingJing · Statistics',
      'bar.stats': 'Review statistics',
      'stats.totals': 'Approvals',
      'stats.lanes': 'AI calls',
      'stats.reviewerInline': 'allow {allow} / ask {ask} / fallback {fallback}',
      'stats.cacheLine': 'approval cache {total} entries · {hits} hits',
      'stats.tokensLine': 'tokens: input {input} · output {output} · cache read {cached}',
      'stats.tokens': 'tokens',
      'stats.hitRate': 'cache hit',
      'stats.lane': 'Lane',
      'stats.calls': 'calls',
      'stats.allow': 'allow',
      'stats.ask': 'ask',
      'stats.fallback': 'fallback',
      'stats.cache': 'approval cache hits',
      'setting.secReview': 'Review',
      'setting.secAgent': 'By requester',
      'setting.agent': 'Who may use the AI review',
      'setting.agentNote': 'Subagents, schedules and the task board default to stricter',
      'setting.secMemory': 'Auto-approve',
      'setting.secCard': 'UI and hint cards',
      'setting.secData': 'Data',
      'list.divider': 'New approvals above',
      'row.showReason': 'Show details',
      'row.hideReason': 'Hide details',
      'row.aiReject': 'Reviewer reason',
      'row.aiAllow': 'Reviewer passed it',
      'row.risk': 'risk',
      'risk.high': 'high',
      'risk.medium': 'medium',
      'risk.low': 'low',
      'risk.unknown': 'unknown',
      'row.copy': 'Copy the command',
      'row.waiting': 'Waiting for you…',
      'row.highRisk': 'High risk',
      'band.advice': 'AI suggests a human · {risk} · {reason}',
      'band.hardRisk': 'Hard risk, never sent to the reviewer ({rule})',
      'band.noAdvice': 'No reviewer advice; judge it yourself',
      'dock.copy': 'Copy',
      'dock.copied': 'Copied',
      'dock.copyFailed': 'Copy failed',
      'dock.otherChip': 'Other session',
      'dock.otherAi': 'AI passed {n}',
      'dock.otherMemory': 'Memory passed {n}',
      'dock.otherHuman': 'Human passed {n}',
      'dock.otherWaitingTitle': 'Another session is waiting for you',
      'dock.otherWaitingOne': '{title}',
      'dock.otherWaitingAgainOne': 'Still waiting: {title}',
      'dock.otherWaitingBody': '{title} ({n})',
      'dock.otherWaitingAgainBody': 'Still waiting: {title} ({n})',
      'config.motto': 'The AI advises from the lamp; the mirror only makes every approval legible.',
      'dock.otherWaitChip': '{n} waiting',
      'config.secAdvanced': 'Advanced (do not fiddle)',
      'config.advancedWarn': 'These change failure behaviour and performance; leave them alone without a reason',
      'config.agentNote': 'Subagents, schedules and the task board default to stricter',
      'config.clearOn': 'Enable "clear history"',
      'config.clearOnNote': 'Shows the clear button in the approval tab (still three clicks)',
      'config.open': 'Open approval tab',
      'setting.grant': 'Allow browser notifications',
      'setting.granted': 'Notifications allowed',
      'setting.export': 'Export ledger',
      'setting.exportAll': 'Export every session',
      'setting.csv': 'CSV',
      'setting.json': 'JSON',
      'setting.danger': 'Danger zone',
      'setting.clear': 'Clear history (this session)',
      'setting.clearOn': 'Enable "clear history"',
      'setting.saved': 'Saved',
      'setting.failed': 'Save failed',
      'setting.clearDone': 'Cleared',
      'config.pollMs': 'Poll interval (ms)',
      'config.maxEntries': 'Entries per session',
      'config.timeout': 'AI timeout (ms)',
      'config.budget': 'Reviews per minute',
      'config.breaker': 'Breaker threshold',
      'config.model': 'Reviewer model (blank = session default)',
      'config.modelAuto': 'Follow the session (default)',
      'config.modelEmpty': 'No lane seen yet — type provider/model',
      'config.modelLocal': 'Do not follow other sessions',
      'config.modelLocalNote': 'When on, this session picks its own reviewer model',
      'model.none': '—',
      'model.next': 'Next review: {lane}',
      'model.nextNone': 'Next review: follows the session (no lane recorded yet)',
      'model.last': 'Last review: {lane}',
      'model.refresh': 'Refresh the provider list',
      'model.skipped': '{n} providers returned no list (missing credentials or a timeout), skipped',
      'preview.kindPending': 'Awaiting approval',
      'preview.kindReviewing': 'reviewer thinking',
      'row.aiNoVerdict': 'no reviewer verdict',
      'row.aiSkipLabel': 'not reviewed:',
      'dock.pendingSkipped': 'not sent to the reviewer ({why}) — your call',
      'preview.kindTimeout': 'reviewer timed out',
      'preview.owner': 'switch: {name}',
      'preview.kindDanger': 'High risk',
      'preview.sampleHint': 'That card is a sample; the rows below are this session live',
      'preview.floatTry': 'Try the floating card',
      'preview.floatTryDanger': 'Try the high-risk floating card',
      'preview.floatHint': 'Click the button: a sample floating card appears at the top of the conversation for 12 seconds. In a real approval it is the surface the host panel cannot cover.',
      'preview.floatShown': 'Sample shown; it disappears after 12 seconds.',
      'preview.floatNoAnchor': 'Sample shown, but the conversation column has not been measured yet (open the chat once, then come back) — it is centred in the window right now, and the width is wrong too.',
      'preview.floatBlocked': 'Turn on both "hint above the input" and "show a hint card while waiting" first — otherwise there is nothing to show.',
      'preview.floatHidden': 'The floating card is hidden while the approval page is on screen (the list already says the same thing). Switch tabs and try again.',
      'preview.floatReason': 'Preview: the reason typed for a sample command',
      'preview.floatAdvice': 'Preview: read-only command, scoped, but this operation is not in memory yet',
      'preview.recent': 'Last 6 in this session',
      'preview.pending': 'Waiting for you',
      'preview.noPending': 'Nothing waiting right now',
      'dock.pendingReviewing': 'the reviewer is thinking… {sec}s {spin}\nYou may click now — your decision is never overwritten by its verdict',
      'dock.pendingFailed': 'the reviewer timed out without a verdict — please decide',
      'config.promptAppend': 'Extra prompt (optional)',
      'config.promptAppendNote': 'Appended after the fixed prompt. The fixed rules are enforced by code; anything here that conflicts is ignored — this adds preference, never removes a red line',
      'config.reviewerLocale': 'Reviewer reason language',
      'config.reviewerLocaleNote': 'Follow the UI = use the panel language; or force Chinese / English',
      'config.localeAuto': 'Follow the UI',
      'config.humanFirst': 'Hand over to the human after (ms)',
      'config.humanFirstNote': 'If the reviewer has not answered in this long, the human options appear first; a later reviewer answer is recorded, never applied. 0 = off',
      'config.reasonChars': 'Reviewer reason length cap (chars)',
      'config.reasonCharsNote': '40-400, default 80. Chinese reasons run longer than English ones — raise it if they feel cut off',
      'config.cacheTtl': 'AI verdict cache TTL (ms)',
      'config.cacheTtlNote': '600000 = 10 minutes; 0 disables the cache (every call reaches the model). Keys are shared across sessions: requester class + argument fingerprint.',
      'config.snapshotDays': 'Snapshot retention (days)',
      'config.snapshotDaysNote': '0 = keep (bounded by 64 entries per session and 64 sessions); set N days and expired snapshots are swept on the next start',
      'config.aiTools': 'Extra tools to send to the AI',
      'config.aiToolsNote': 'Comma or newline separated. The built-in baseline (shell, read-only file/search, read-only network, job output) is hardcoded; list only the additions. write/edit are memory-tier and unaffected.',
      'config.aiToolsDeny': 'Tools kept away from the AI (deny list)',
      'config.aiToolsDenyNote': 'Comma or newline separated. A tool listed here always asks you first, overriding the built-in baseline too; memory-tier tools are unaffected.',
      'config.agent': 'AI ceiling by requester',
      'config.save': 'Save',
      'config.saved': 'Saved',
      'config.failed': 'Save failed',
      'config.loading': 'Loading…',
    };

    function isPlainObject(value) {
      return value !== null && typeof value === 'object' && Array.isArray(value) === false;
    }

    function translator(props) {
      const locale = props && props.locale;
      return function t(key, params) {
        let text = key;
        try {
          if (typeof locale === 'function') text = locale(key);
        } catch (error) {
          text = key;
        }
        if (typeof text !== 'string' || text === key) text = (zh[key] !== undefined ? zh[key] : key);
        if (isPlainObject(params)) {
          for (const name of Object.keys(params)) text = text.split('{' + name + '}').join(String(params[name]));
        }
        return text;
      };
    }

    const API_BASE = (function () {
      try {
        return new URL('api/review-hub', document.baseURI).pathname;
      } catch (error) {
        return '/api/review-hub';
      }
    })();

    const store = {
      sessionId: '',
      entries: [],
      cursor: 0,
      stats: null,
      pending: [],
      hints: [],
      config: null,
      memory: null,
      /** Which session `memory` belongs to: the count is meaningless without it. */
      memorySid: '',
      /** File-level approval counts: [{path, count, auto}] for the session on screen. */
      files: [],
      /** True when /files answered nothing usable — the host half is older than the UI. */
      filesError: false,
      online: true,
      filterOpen: false,
      settingsOpen: false,
      query: '',
      /** Approval-page tool filter; '' means every tool. */
      tool: '',
      fromTime: '',
      toTime: '',
      showMemory: false,
      models: null,
      diff: null,
      /** True while the approval list is actually visible (see IntersectionObserver). */
      pageVisible: false,
      /** Rows newer than seenAt from AI/memory/external: the tab badge reads this. */
      unread: 0,
      /** Per-session "already looked at" watermark (localStorage, per browser). */
      seenAt: 0,
      /** Hint baseline: rows at or below this ts are history, never a card. */
      hintFloor: 0,
      hintFloorSid: '',
      hintSeeded: '',
      /** Other sessions' activity, aggregated: never a coloured card. */
      others: [],
      othersDismissedAt: 0,
      /** Other sessions' waiting approvals: [{sessionId,title,count,oldest}] */
      otherPending: [],
      /** Pending 'commit the watermark' timer: leaving briefly must not clear the divider. */
      seenTimer: null,
      streaming: false,
      /** callId whose undo button is armed: a second click within REVERT_CONFIRM_MS runs it. */
      revertArmed: '',
    };
    const listeners = new Set();
    let memoryAt = 0;

    function notify() {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (error) {
          console.error('[review-hub] listener failed', error);
        }
      }
    }

    function useStore() {
      const pair = React.useState(0);
      const bump = pair[1];
      React.useEffect(function () {
        const listener = function () { bump(function (n) { return n + 1; }); };
        listeners.add(listener);
        return function () { listeners.delete(listener); };
      }, []);
      return store;
    }

    async function api(path, options) {
      const response = await fetch(API_BASE + path, Object.assign({ cache: 'no-store' }, options || {}));
      if (response.ok !== true) throw new Error('HTTP ' + response.status);
      return response.json();
    }

    async function postJson(path, body) {
      return api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    }

    /**
     * One-shot header-probe self-report, so the server can tell what the panel's own
     * JavaScript can see (cookie names) versus what only the shell sends. Inert unless
     * the plugin config turns the probe on: the route is absent then and this 404s.
     * Runs once per page load; any failure is ignored — forensics is not a feature.
     */
    let probeReported = false;
    function reportProbe() {
      if (probeReported === true) return;
      probeReported = true;
      try {
        const cookieNames = String(document.cookie || '')
          .split(';')
          .map(function (part) { return part.split('=')[0].trim(); })
          .filter(function (name) { return name !== ''; });
        void api('/probe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ origin: String(location.origin || ''), cookieNames: cookieNames, globals: [] }),
        }).catch(function () {});
      } catch (error) {
        // No document, no cookies, no probe. Nothing to do.
      }
    }

    let revertArmTimer = null;
    /** The host re-reads a view's label only when the slot table changes, so the
     *  badge is applied by re-registering that one seat (id and order unchanged). */
    let pushTabLabel = function () {};
    let viewDispose = null;
    let viewLabel = '审批';
    /** Right-sidebar face: present only when the host provides it. */
    let sideAvailable = false;
    let sideOpen = null;
    const TAB_KIND = 'review-hub-diff';
    const SETTINGS_KIND = 'review-hub-settings';
    const STATS_KIND = 'review-hub-stats';
    const MEMORY_KIND = 'review-hub-memory';
    let sideOpenSettings = null;
    let sideOpenStats = null;
    let sideOpenMemory = null;
    const seenPending = new Set();
    /** Rows already turned into a dock hint / toast: the poller sees them again every second. */
    const hinted = new Set();
    const dismissed = new Set();

    function settings() {
      return isPlainObject(store.config) ? store.config : {};
    }

    function mergeRows(existing, incoming) {
      const byId = new Map();
      for (const row of existing) byId.set(row.id, row);
      for (const row of incoming) byId.set(row.id, row);
      return [...byId.values()].sort(function (a, b) { return (Number(b.ts) || 0) - (Number(a.ts) || 0); }).slice(0, 200);
    }

    /** Per-kind card lifetime; 0 means "until the decision lands" (pending only). */
    function hintMsOf(kind) {
      const table = isPlainObject(settings().hintMs) ? settings().hintMs : {};
      const value = Number(table[kind]);
      if (Number.isFinite(value) && value >= 0) return value;
      if (kind === 'memory') return 8000;
      if (kind === 'pending') return 0;
      return 30000;
    }

    function storageGet(key) {
      try {
        const value = Number(window.localStorage.getItem(key));
        return Number.isFinite(value) ? value : 0;
      } catch (error) {
        return 0;
      }
    }

    function storageSet(key, value) {
      try {
        window.localStorage.setItem(key, String(value));
      } catch (error) {
        /* private mode: the in-memory value still works for this page */
      }
    }

    /** Only a stable automatic decision becomes a card, only once, only after the baseline. */
    function shouldHint(row, floor, already) {
      if (row === null || typeof row !== 'object') return false;
      if (already !== undefined && already.has(String(row.id))) return false;
      if (row.decidedBy !== 'ai' && row.decidedBy !== 'memory') return false;
      return (Number(row.ts) || 0) > (Number(floor) || 0);
    }

    /** "New since you looked": human decisions are excluded on purpose. */
    function unreadCount(rows, seenAt) {
      const mark = Number(seenAt) || 0;
      let count = 0;
      for (const row of Array.isArray(rows) ? rows : []) {
        if ((Number(row.ts) || 0) <= mark) continue;
        if (row.decidedBy === 'human' || row.decidedBy === 'fallback') continue;
        count += 1;
      }
      return count;
    }

    /** Index of the first row at or below the watermark: everything above it is new. */
    function dividerAt(rows, seenAt) {
      const mark = Number(seenAt) || 0;
      if (mark <= 0) return -1;
      const list = Array.isArray(rows) ? rows : [];
      return list.findIndex(function (row) { return (Number(row.ts) || 0) <= mark; });
    }

    /** Splice the "new since your last visit" rule into a row list. */
    function withDivider(rows, entries, seenAt, t) {
      const at = dividerAt(entries, seenAt);
      if (at <= 0) return rows;
      const out = rows.slice(0, at);
      out.push(h('div', { className: 'ah-divider', key: 'ah-divider' },
        h('span', { className: 'ah-divider-text' }, t('list.divider'))));
      return out.concat(rows.slice(at));
    }

    const ICON_PATHS = {
      // Two sheets, the way the host draws it: the back one only shows its corner.
      copy: 'M7.4 6.4V4.7A1.7 1.7 0 0 1 9.1 3h5.2A1.7 1.7 0 0 1 16 4.7v5.2a1.7 1.7 0 0 1-1.7 1.7h-1.7M4 9.2a1.7 1.7 0 0 1 1.7-1.7h5.1A1.7 1.7 0 0 1 12.5 9.2v5.1A1.7 1.7 0 0 1 10.8 16H5.7A1.7 1.7 0 0 1 4 14.3z',
      close: 'M6 6l8 8M14 6l-8 8',
      // Four bars of uneven length: "statistics", not "settings".
      stats: 'M4.5 17V8.5M8.5 17V3.5M12.5 17V10.5M16.5 17V5.5',
      chevronDown: 'M5.5 8.2l4.5 4.6 4.5-4.6',
      chevronUp: 'M5.5 11.8l4.5-4.6 4.5 4.6',
      diff: 'M4.5 6.5h9M4.5 10h6M4.5 13.5h9',
      // A pencil: the nib at the lower left, the body reaching the upper right corner.
      pencil: 'M3.5 16.5l.8-3.4 9.2-9.2a1.7 1.7 0 0 1 2.4 0l.2.2a1.7 1.7 0 0 1 0 2.4l-9.2 9.2-3.4.8zM12.1 5.4l2.5 2.5',
      // A cog a 16px box can still read: eight teeth, one ring, nothing else.
      gear: 'M10.00 1.60L12.37 4.27L15.94 4.06L15.73 7.63L18.40 10.00L15.73 12.37L15.94 15.94L12.37 15.73L10.00 18.40L7.63 15.73L4.06 15.94L4.27 12.37L1.60 10.00L4.27 7.63L4.06 4.06L7.63 4.27zM7.3 10a2.7 2.7 0 1 0 5.4 0 2.7 2.7 0 1 0-5.4 0z',
      // Centred in the 20x20 box: the circle sits at (9,9) and only the handle
      // reaches the corner, so the glyph reads as centred inside a 24px button.
      search: 'M9 3a6 6 0 1 0 0 12A6 6 0 0 0 9 3zM13.4 13.4 18 18',
      // A near-full circle with a corner bracket: the catalog refetch.
      refresh: 'M16.5 10a6.5 6.5 0 1 1-2.4-5M16.5 3v3.6h-3.6',
    };

    /** One inline stroke glyph; no emoji, no text, no icon font. */
    function icon(name, size) {
      const box = Number(size) > 0 ? Number(size) : 14;
      return h('svg', {
        width: box,
        height: box,
        viewBox: '0 0 20 20',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }, h('path', { d: ICON_PATHS[name] || ICON_PATHS.close }));
    }

    /** Icon-only control: the label lives in title/aria, never in the pixels. */
    function iconButton(name, label, onClick, extraClass) {
      return h('button', {
        type: 'button',
        className: 'ah-icon-btn' + (extraClass === undefined ? '' : ' ' + extraClass),
        title: label,
        'aria-label': label,
        onClick: onClick,
      }, icon(name));
    }

    async function copyToClipboard(text) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(String(text));
          return true;
        }
      } catch (error) {
        /* permission denied: report it instead of throwing into the render */
      }
      return false;
    }

    function pushHint(kind, entry) {
      const hint = { id: 'h-' + entry.id, kind: kind, entry: entry, ts: Date.now() };
      store.hints = store.hints.filter(function (item) { return item.id !== hint.id; }).concat([hint]);
      notify();
      const ttl = hintMsOf(kind);
      if (ttl <= 0) return;
      setTimeout(function () {
        store.hints = store.hints.filter(function (item) { return item.id !== hint.id; });
        notify();
      }, ttl);
    }

    /** The session's live threshold, for rows that never froze one. */
    function liveThreshold() {
      const raw = Number(settings().threshold);
      return Number.isFinite(raw) && raw > 0 ? raw : 3;
    }

    /**
     * Did this row fold knobs away *and* get approved more than once? "合并" is a property of
     * the *memory sentence*, not a separate badge: it reads "合并记忆 3/3 次", the same number
     * the row already prints. A second chip repeating that number was pure noise. The first
     * occurrence is not merged yet, so nothing is prefixed there.
     */
    function isMerged(entry) {
      if (entry === null || typeof entry !== 'object') return false;
      if (entry.fpMode !== 'normalized') return false;
      if (Array.isArray(entry.droppedKeys) === false || entry.droppedKeys.length === 0) return false;
      const count = Number(entry.memoryCount);
      return Number.isFinite(count) && count >= 2;
    }

    /**
     * Did the reviewer look at this row and send it back to a human? A row the AI allowed
     * is decidedBy 'ai', so any other decider plus a recorded reviewer source means the
     * reviewer chose "ask" — the request came back with a verdict, not silence.
     */
    function aiEscalated(entry) {
      if (entry === null || typeof entry !== 'object') return false;
      // Memory runs *before* the reviewer (index.js: memory -> file-level -> AI), so a
      // memory decision can never carry a reviewer source. Only the layers that sit
      // after the AI can.
      if (entry.decidedBy !== 'human' && entry.decidedBy !== 'external' && entry.decidedBy !== 'fallback') return false;
      return entry.aiSource === 'ai' || entry.aiSource === 'cache';
    }

    function chipOf(entry, t) {
      const by = entry && entry.decidedBy;
      const denied = entry && entry.outcome === 'rejected';
      const cancelled = entry && entry.outcome === 'cancelled';
      const pre = aiEscalated(entry) === true && cancelled === false ? t('chip.aiRejected') : undefined;
      if (cancelled) return { text: t('chip.cancelled'), tone: 'muted' };
      if (by === 'memory') return { text: t('chip.memory'), tone: 'learn' };
      if (by === 'ai') return { text: denied ? t('chip.aiDeny') : t('chip.ai'), tone: denied ? 'danger' : 'ok' };
      if (by === 'human') return { text: denied ? t('chip.humanDeny') : t('chip.human'), tone: denied ? 'danger' : 'warn', pre: pre };
      if (by === 'external') return { text: t('chip.external'), tone: 'muted', pre: pre };
      return { text: denied ? t('chip.rejected') : t('chip.fallback'), tone: denied ? 'danger' : 'muted', pre: pre };
    }

    /** The file this approval touches and how many human approvals it has, if known. */
    function fileCountOf(entry) {
      const stored = entry !== null && entry !== undefined && typeof entry.filePath === 'string' ? entry.filePath : '';
      const payload = stored === '' ? argsOf(entry) : null;
      const path = stored !== ''
        ? stored
        : (isPlainObject(payload) === true
          ? String(payload.file_path || payload.path || payload.target_path || '')
          : '');
      if (path === '') return null;
      const files = Array.isArray(store.files) ? store.files : [];
      for (const item of files) if (item.path === path) return { path: path, count: Number(item.count) || 0 };
      return { path: path, count: 0 };
    }

    /**
     * The counter shown on an approval row. Edits of the same file count together (that
     * is the number the file-level switch uses), so the row says "this file: n/N" rather
     * than "this exact text: 1/N" — once it is full, it points at the switch.
     */
    /**
     * Human approvals of this file **up to and including this row**: the counter grows
     * 1 → 2 → 3 down the list instead of every row jumping to the file's current total.
     */
    function fileRunningCount(entry, path) {
      if (path === '') return null;
      let count = 0;
      let seen = false;
      const stamp = Number(entry?.ts) || 0;
      for (const row of store.entries) {
        const rowPath = fileCountOf(row) === null ? '' : fileCountOf(row).path;
        if (rowPath !== path) continue;
        if (row.outcome !== 'allowed-once' || row.decidedBy !== 'human') continue;
        if ((Number(row.ts) || 0) > stamp) continue;
        count += 1;
        if (row.id === entry.id) seen = true;
      }
      return seen === true ? count : null;
    }

    /** The threshold frozen onto the row, falling back to the live setting. */
    function rowThreshold(entry, live) {
      const stored = Number(entry !== null && entry !== undefined ? entry.threshold : NaN);
      return Number.isFinite(stored) && stored > 0 ? stored : live;
    }

    /**
     * What the chip says after the decision. `long` is the full sentence, `short` the
     * form for a narrow pane, and `null` means both are the same string — the row picks
     * a span per width, so a sidebar opening can never clip the date off the right edge.
     */
    function memoryText(entry, t) {
      const live = liveThreshold();
      const threshold = rowThreshold(entry, live);
      // Three pieces, because a narrow pane drops the unit word ("次") while keeping the
      // fraction — "记忆 1/3 次" → "记忆 1/3".
      const merged = isMerged(entry);
      // 合并 is a separate word on purpose: a narrow pane drops it first and keeps
      // "记忆 n/N 次" — the count is the fact, "merged" is the footnote.
      const progress = function (count) {
        const pre = merged ? t('memory.mergedPrefix') : '';
        const lead = t('memory.progressLead');
        const frac = count + '/' + threshold;
        const unit = t('memory.progressUnit');
        return {
          long: [pre === '' ? lead : pre + lead, frac, unit].filter(function (part) { return part !== ''; }).join(' '),
          short: null,
          parts: { pre: pre, lead: lead, frac: frac, unit: unit },
        };
      };
      const file = fileCountOf(entry);
      if (file !== null) {
        const running = fileRunningCount(entry, file.path);
        const count = running === null ? file.count : running;
        // "已满" means *past* the threshold: the row that reaches it still shows n/N,
        // which is what that approval actually completed.
        if (count > threshold) {
          const full = merged ? t('memory.fullMerged') : t('memory.full');
          return { long: full + ' · ' + t('memory.canArm'), short: full + ' · ' + t('memory.canArmShort') };
        }
        return progress(count);
      }
      const count = Number(entry && entry.memoryCount);
      if (Number.isFinite(count) === false || count <= 0) return null;
      return progress(count);
    }

    /**
     * The chip body as separate groups — reviewer verdict, decision, merge note, memory
     * sentence — each carrying its own separators. A narrow pane hides whole groups by
     * container query, so the chip degrades one fact at a time instead of showing an
     * ellipsis in the middle of "AI 打回 · 人工通过".
     */
    function chipBody(chip, memory, t) {
      const parts = [];
      if (chip.pre !== undefined) parts.push(h('span', { className: 'ah-chip-pre', key: 'pre' }, chip.pre + ' · '));
      parts.push(h('span', { className: 'ah-chip-decision', key: 'decision' }, chip.text));
      if (memory !== null) {
        const body = memory.parts !== undefined
          ? [
            memory.parts.pre === '' ? null : h('span', { className: 'ah-chip-mem-pre', key: 'pre' }, memory.parts.pre),
            h('span', { className: 'ah-chip-mem-lead', key: 'lead' }, memory.parts.lead + ' '),
            h('span', { className: 'ah-chip-mem-frac', key: 'frac' }, memory.parts.frac),
            memory.parts.unit === '' ? null : h('span', { className: 'ah-chip-mem-unit', key: 'unit' }, ' ' + memory.parts.unit),
          ]
          : (memory.short === null
            ? memory.long
            : [
              h('span', { className: 'ah-chip-long', key: 'long' }, memory.long),
              h('span', { className: 'ah-chip-short', key: 'short' }, memory.short),
            ]);
        parts.push(h('span', { className: 'ah-chip-mem', key: 'mem' }, ' · ', body));
      }
      return parts;
    }

    /**
     * A lane the way the host names it: `providerName/modelName`. The stored lane is
     * ids (`qodercn/qfmodel`); the catalog carries the readable names, and its model
     * name is what the composer's own picker shows ("Qwen3.8-Flash · 免费").
     */
    function laneLabel(lane) {
      const text = typeof lane === 'string' ? lane : '';
      if (text === '') return '';
      const catalog = isPlainObject(store.models) ? store.models : {};
      const providers = Array.isArray(catalog.providers) ? catalog.providers : [];
      const at = text.indexOf('/');
      if (at <= 0) return text;
      const providerId = text.slice(0, at);
      const modelId = text.slice(at + 1);
      let providerName = providerId;
      let modelName = modelId;
      for (const provider of providers) {
        if (isPlainObject(provider) === false || provider.id !== providerId) continue;
        if (typeof provider.name === 'string' && provider.name !== '') providerName = provider.name;
        for (const model of Array.isArray(provider.models) ? provider.models : []) {
          if (isPlainObject(model) === false || model.id !== modelId) continue;
          if (typeof model.name === 'string' && model.name !== '') modelName = model.name;
        }
      }
      return providerName + '/' + modelName;
    }

    /**
     * The AI lane that decided a row, shown just before its timestamp. Memory and
     * human decisions have no model to show, and a lane nobody recorded stays empty
     * rather than inventing one.
     */
    function rowModelOf(entry) {
      if (entry === null || typeof entry !== 'object') return null;
      // The lane that actually reviewed wins over the session's lane: with a pinned
      // reviewer they differ, and the row should name the judge.
      const reviewed = typeof entry.aiModel === 'string' ? entry.aiModel : '';
      const lane = reviewed !== ''
        ? reviewed
        : (entry.decidedBy === 'ai' && typeof entry.routeModel === 'string' ? entry.routeModel : '');
      if (lane === '') return null;
      const label = laneLabel(lane);
      return { text: label === '' ? lane : label, title: lane };
    }

    /**
     * A lane label split into the parts a narrow pane can drop, in the order they stop
     * being worth the width: the multiplier, then the provider, then the qualifier
     * ("-Flash", "-Lite") that still leaves a recognisable family name behind.
     */
    function laneParts(text) {
      const raw = typeof text === 'string' ? text : '';
      const slash = raw.indexOf('/');
      const provider = slash > 0 ? raw.slice(0, slash + 1) : '';
      const rest = slash > 0 ? raw.slice(slash + 1) : raw;
      const dot = rest.indexOf(' · ');
      const model = dot > 0 ? rest.slice(0, dot) : rest;
      const price = dot > 0 ? rest.slice(dot + 3) : '';
      const dash = model.lastIndexOf('-');
      const short = dash > 0 ? model.slice(0, dash) : model;
      return { provider: provider, model: model, price: ' · ' + price, short: short };
    }

    function stampOf(ts) {
      const value = Number(ts);
      if (Number.isFinite(value) === false || value <= 0) return '';
      const date = new Date(value);
      const pad = function (part) { return String(part).padStart(2, '0'); };
      return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
    }

    /**
     * Fallback verdicts used to be written into `aiReason`; they are diagnostics, so
     * rows from that era must not grow a "show description" button around them.
     */
    const NOT_A_DESCRIPTION = [
      'reviewer reply was not a verdict',
      'reviewer failed:',
      'reviewer circuit open',
      'per-turn review budget spent',
      'no llm service',
      'ai disabled',
    ];

    function isDescription(text) {
      if (typeof text !== 'string' || text === '') return false;
      for (const prefix of NOT_A_DESCRIPTION) {
        if (text === prefix || text.startsWith(prefix)) return false;
      }
      return true;
    }

    function reasonOf(entry) {
      if (isDescription(entry.aiReason)) return entry.aiReason;
      if (isDescription(entry.reason)) return entry.reason;
      return '';
    }

    /**
     * The description panel, split into what the caller said and what the reviewer said.
     * `reason` is the request's own words; `aiReason` is the verdict's. "Sent it back" and
     * "let it through" are both worth reading and they are *different* facts, so the caller's
     * line is never sacrificed to make room for the reviewer's.
     */
    const RISK_WORDS = { high: 'risk.high', medium: 'risk.medium', low: 'risk.low', unknown: 'risk.unknown' };

    /** The reviewer's own risk word, in the reader's language; anything else is printed as-is. */
    function riskLabel(risk, t) {
      const key = RISK_WORDS[String(risk)];
      return key === undefined ? String(risk) : t(key);
    }

    /** The risk the reviewer attached to its verdict (falling back to the row's own level). */
    function riskOf(entry) {
      if (entry === null || entry === undefined) return '';
      if (typeof entry.aiRisk === 'string' && entry.aiRisk !== '') return entry.aiRisk;
      if (typeof entry.riskLevel === 'string' && entry.riskLevel !== '') return entry.riskLevel;
      return '';
    }

    function reasonBlockOf(entry) {
      const own = isDescription(entry.reason) ? entry.reason : '';
      const ai = isDescription(entry.aiReason) ? entry.aiReason : '';
      const risk = riskOf(entry);
      // Why the reviewer was never asked belongs in the detail, next to the verdict fields:
      // it is an audit fact, not something to interrupt the human with.
      if (typeof entry.aiSkip === 'string' && entry.aiSkip !== '') {
        return { own: own, ai: entry.aiSkip, label: 'row.aiSkipLabel', risk: risk };
      }
      if (ai === '' || ai === own) return { own: own !== '' ? own : ai, ai: '', label: '', risk: '' };
      if (aiEscalated(entry) === true) return { own: own, ai: ai, label: 'row.aiReject', risk: risk };
      if (entry !== null && entry !== undefined && entry.decidedBy === 'ai') return { own: own, ai: ai, label: 'row.aiAllow', risk: risk };
      return { own: own !== '' ? own : ai, ai: '', label: '', risk: '' };
    }

    /** The payload keys that are worth showing on their own, most specific first. */
    const PAYLOAD_KEYS = ['command', 'cmd', 'script', 'file_path', 'path', 'target', 'target_path'];

    /** Parsed arguments of a row, or null when nothing parseable was stored. */
    function argsOf(entry) {
      const raw = entry !== null && entry !== undefined && typeof entry.argsText === 'string' ? entry.argsText : '';
      if (raw.trim().charAt(0) !== '{') return null;
      try {
        const parsed = JSON.parse(raw);
        return isPlainObject(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }

    function lineCountOf(text) {
      return typeof text === 'string' && text !== '' ? text.split('\n').length : 0;
    }

    /**
     * How big the change was, read from the arguments themselves: an edit carries the
     * text it removes and the text it adds, a write carries the whole new body. This is
     * a cheap "+N −N" — not a real diff, and it costs no disk read.
     */
    function deltaOf(payload) {
      if (isPlainObject(payload) === false) return null;
      const removed = lineCountOf(payload.old_string);
      const added = lineCountOf(payload.new_string);
      if (removed > 0 || added > 0) return { add: added, del: removed };
      const written = lineCountOf(payload.content);
      if (written > 0) return { add: written, del: 0 };
      return null;
    }

    /**
     * The chip's numbers for a recorded row: the real diff stats stored when the row
     * landed, falling back to the argument estimate for rows written before that.
     */
    function rowDelta(entry) {
      const recorded = entry !== null && entry !== undefined ? entry.fileDelta : undefined;
      if (isPlainObject(recorded) === true) {
        return { add: Number(recorded.add) || 0, del: Number(recorded.del) || 0 };
      }
      return deltaOf(argsOf(entry));
    }

    /** The "+N −N" chip, or null when the row changes no text. */
    function deltaChip(delta, key) {
      if (delta === null) return null;
      return h('span', { className: 'ah-delta', key: key || 'delta' },
        h('span', { className: 'ah-delta-add' }, '+' + String(delta.add)),
        h('span', { className: 'ah-delta-del' }, '−' + String(delta.del)));
    }
    /**
     * What was actually approved. The raw `argsText` is a JSON blob: pasted into a
     * terminal it does not run, and on a short command it is mostly `\n` escapes.
     * So the payload is unwrapped to the one value a human would type — the command,
     * or the path — and anything unrecognised falls back to the raw text unchanged.
     */
    /**
     * Keys that only change *which slice* of the same operation is asked for. The
     * fingerprint already strips them (store.js KNOB_KEYS); this is the display half, so
     * a row does not lead with "limit/offset" while the chip says "merged".
     */
    const KNOB_KEYS = ['limit', 'offset', 'page', 'size', 'count', 'max_results', 'maxResults', 'since', 'until', 'recent', 'timeout', 'timeoutMs', 'graceMs', 'description'];

    /** The command as shown: knobs dropped when the setting asks for it. Never for copy. */
    function displayCommand(text) {
      const raw = typeof text === 'string' ? text : '';
      if (settings().hideKnobs !== true || raw.trim().charAt(0) !== '{') return raw;
      try {
        const parsed = JSON.parse(raw);
        if (isPlainObject(parsed) === false) return raw;
        const out = {};
        let dropped = 0;
        for (const [key, value] of Object.entries(parsed)) {
          if (KNOB_KEYS.indexOf(key) >= 0) { dropped += 1; continue; }
          out[key] = value;
        }
        return dropped === 0 ? raw : JSON.stringify(out);
      } catch {
        /* truncated or not JSON: show what we have */
        return raw;
      }
    }

    function commandOf(entry) {
      const raw = typeof entry.argsText === 'string' && entry.argsText !== ''
        ? entry.argsText
        : (typeof entry.argsSummary === 'string' ? entry.argsSummary : '');
      if (raw.trim().charAt(0) !== '{') return raw;
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return raw;
      }
      if (!isPlainObject(parsed)) return raw;
      for (const key of PAYLOAD_KEYS) {
        const value = parsed[key];
        if (typeof value === 'string' && value !== '') return value;
      }
      return raw;
    }

    /**
     * One dock card. The dock and the settings preview both render through this, so
     * a tone, a chip or an ellipsis fixed here is fixed in both places at once.
     */
    /**
     * The card's own countdown: a thick arc drains clockwise and leaves a thin outline
     * behind, so "this card is about to disappear" is readable without a number.
     * The animation is started with a negative delay equal to the time already spent,
     * which keeps it in step with the hide timer that pushHint() already runs.
     */
    function ringTiming(ms, spent) {
      const total = Math.max(1, Number(ms) || 0);
      const used = Math.max(0, Math.min(Number(spent) || 0, total));
      return { durationMs: total, delayMs: -used };
    }

    function countdownRing(ms, spent) {
      const timing = ringTiming(ms, spent);
      return h('span', { className: 'ah-ring', key: 'ring', 'aria-hidden': 'true' },
        h('svg', { viewBox: '0 0 16 16', width: 14, height: 14 },
          h('circle', { className: 'ah-ring-track', cx: 8, cy: 8, r: 5 }),
          h('circle', {
            className: 'ah-ring-arc',
            cx: 8,
            cy: 8,
            r: 5,
            style: { animationDuration: timing.durationMs + 'ms', animationDelay: timing.delayMs + 'ms' },
          })
        )
      );
    }

    /** The verdict chip's colour, derived from the card's kind (and risk wins). */
    function cardChipClass(kind, danger) {
      return 'ah-card-chip ah-card-chip-' + (danger === true ? 'danger' : String(kind || 'other'));
    }

    function cardNode(props) {
      const extra = Array.isArray(props.extra) ? props.extra : [];
      return h('div', { className: 'ah-card ah-card-' + props.kind + (props.danger === true ? ' ah-card-danger' : ''), key: props.key },
        // A decision chip only makes sense once there *is* a decision: the pending
        // card is rendered before one exists, so it shows the risk (if any) and no verdict.
        props.chip === '' || props.chip === undefined ? null : h('span', { className: cardChipClass(props.kind, props.danger) }, props.chip),
        h('span', { className: 'ah-card-body' },
          h('span', { className: 'ah-card-main' }, props.main),
          h('span', { className: 'ah-card-sub' }, props.sub)
        ),
        props.ringMs > 0 ? countdownRing(props.ringMs, props.ringSpentMs) : null,
        ...extra
      );
    }

    /**
     * The waiting card, rendered outside every host surface.
     *
     * The native approval panel takes the composer seat, and the dock card above it ends
     * up behind that panel — the one thing the human needs (what the AI made of this
     * request) is the first thing hidden. Registering into a host sub-seat was tried
     * twice and broke the web boot both times, so this does the opposite: it appends one
     * plain node to `document.body`, which no ancestor layout, transform or stacking
     * context can cover.
     */
    const adviceOverlay = { node: null, signature: '', dismissed: new Set(), anchor: null, settled: new Set(), currentId: '', clickHooked: false };
    // While the reviewer is still thinking, the card has nothing to report but must not look
    // frozen: a 500ms tick cycles the spinner glyph. The timer is owned here and cleared the
    // moment no pending row is being reviewed, so a re-mount cannot leak it.
    const reviewSpin = { frame: 0, timer: null, glyphs: ['│', '/', '─', '\\'] };

    function removeAdviceOverlay() {
      if (adviceOverlay.node !== null && adviceOverlay.node.parentNode !== null) {
        adviceOverlay.node.parentNode.removeChild(adviceOverlay.node);
      }
      adviceOverlay.node = null;
      adviceOverlay.signature = '';
    }

    /**
     * Where the conversation column actually is, measured from the dock we already have.
     *
     * The overlay has to sit on the conversation, not on the window: with a left sidebar
     * open, "centred in the viewport" is visibly off-centre from the chat. The dock is
     * the one node we own that is laid out exactly like the composer, so it is both the
     * column's x/width and the anchor for "top of the conversation".
     */
    function describeDockAnchor(node) {
      if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return null;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0) return null;
      let top = 0;
      let walk = node.parentElement;
      const view = typeof window === 'undefined' ? null : window;
      while (walk !== null && walk !== undefined && walk !== document.body && view !== null) {
        const style = view.getComputedStyle(walk);
        const scrolls = style.overflowY === 'auto' || style.overflowY === 'scroll';
        if (scrolls === true && walk.scrollHeight > walk.clientHeight + 4) {
          top = walk.getBoundingClientRect().top + 8;
          break;
        }
        walk = walk.parentElement;
      }
      // No scrolling ancestor (a short conversation): sit just above the dock instead.
      if (top === 0) top = Math.max(8, rect.top - 120);
      return { left: rect.left, width: rect.width, top: top };
    }

    function placeAdviceOverlay(anchor) {
      const node = adviceOverlay.node;
      if (node === null) return;
      // Fall back to measuring the dock ourselves before surrendering to the CSS
      // "centred in the viewport" rule: with the sidebar open that rule lands the card
      // off the conversation column (visibly to the right and too narrow).
      if ((anchor === null || anchor === undefined) && typeof document !== 'undefined') {
        anchor = describeDockAnchor(document.querySelector('.ah-dock'));
      }
      if (anchor === null || anchor === undefined) {
        node.style.left = '';
        node.style.width = '';
        node.style.top = '';
        node.style.transform = '';
        return;
      }
      // The dock's own padding is already inside rect.width, so the card matches the dock
      // edge to edge instead of standing proud of it.
      node.style.left = anchor.left + 'px';
      node.style.width = anchor.width + 'px';
      node.style.top = anchor.top + 'px';
      node.style.transform = 'none';
    }

    function syncAdviceOverlay(t, anchor) {
      if (typeof document === 'undefined' || document.body === null || document.body === undefined) return;
      // Keep the last real measurement: the settings page has no dock of its own, and the
      // preview there should still land on the conversation instead of the window centre.
      if (anchor !== null && anchor !== undefined) adviceOverlay.anchor = anchor;
      const placed = anchor === null || anchor === undefined ? adviceOverlay.anchor : anchor;
      const session = store.sessionId;
      const row = (Array.isArray(store.pending) ? store.pending : []).find(function (item) {
        if (item === null || item === undefined) return false;
        if (typeof item.sessionId === 'string' && item.sessionId !== '' && item.sessionId !== session) return false;
        if (item.aiReviewed === false) return false;
        if (adviceOverlay.dismissed.has(String(item.id)) === true) return false;
        // A hard-risk request never reaches the reviewer, so it has no advice — but it is
        // still a decision only a human can make, which is exactly what this card is for.
        if (item.riskLevel === 'high') return true;
        return typeof item.aiReason === 'string' && item.aiReason !== '';
      });
      const wanted = row !== undefined && settings().composerHint !== false
        && settings().pendingCard === true && store.pageVisible !== true;
      if (wanted === false) {
        removeAdviceOverlay();
        return;
      }
      const signature = String(row.id) + '\u0000' + String(row.aiReason || '') + '\u0000' + String(row.riskRule || '');
      if (adviceOverlay.node !== null && adviceOverlay.signature === signature) {
        // Content unchanged: only the geometry can have moved (sidebar opened, window
        // resized), and that is a couple of style writes.
        placeAdviceOverlay(placed);
        return;
      }
      removeAdviceOverlay();

      const dangerous = row.riskLevel === 'high';
      const node = document.createElement('div');
      node.className = 'ah-float ah-card-pending' + (dangerous ? ' ah-card-danger ah-float-danger' : '');
      const head = document.createElement('div');
      head.className = 'ah-float-head';
      const chip = document.createElement('span');
      chip.className = 'ah-card-chip ' + (dangerous ? 'ah-card-chip-danger' : 'ah-card-chip-pending');
      chip.textContent = dangerous ? t('row.highRisk') : t('dock.pending');
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'ah-icon-btn ah-float-close';
      close.title = t('dock.dismiss');
      close.textContent = '×';
      close.addEventListener('click', function () {
        adviceOverlay.dismissed.add(String(row.id));
        removeAdviceOverlay();
        notify();
      });
      head.appendChild(chip);
      head.appendChild(close);
      const main = document.createElement('div');
      main.className = 'ah-float-main';
      main.textContent = String(row.toolName || '') + ' · ' + String(row.argsSummary || row.reason || '').slice(0, 160);
      const sub = document.createElement('div');
      sub.className = 'ah-float-sub';
      sub.textContent = typeof row.aiReason === 'string' && row.aiReason !== ''
        ? t('dock.pendingAi', { risk: String(row.aiRisk || 'unknown'), reason: row.aiReason })
        : (dangerous
          ? t('dock.pendingDanger', { rule: String(row.riskRule || t('row.highRisk')) })
          : t('dock.pendingLine', { time: stampOf(row.startedAt) }));
      node.appendChild(head);
      node.appendChild(main);
      node.appendChild(sub);
      document.body.appendChild(node);
      adviceOverlay.node = node;
      adviceOverlay.signature = signature;
      placeAdviceOverlay(placed);
    }

    function toast(title, body, options) {
      if (settings().toastEnabled !== true) return;
      try {
        if (typeof Notification === 'undefined') return;
        if (Notification.permission !== 'granted') return;
        const sticky = options !== null && options !== undefined && options.sticky === true;
        new Notification(title, { body: body, requireInteraction: sticky, tag: sticky ? 'review-hub-waiting-' + String(options.key || '') : undefined });
      } catch (error) {
        /* notifications are a nicety, never a failure */
      }
    }

    /**
     * A pending row only becomes a toast once the reviewer has finished with it
     * (`aiReviewed`): firing earlier would tell the human "waiting" and drop the
     * one thing that helps them decide — what the AI made of it. Wording rule:
     * the AI *suggests*, the human decides.
     */
    /**
     * The body of a "another session is waiting" toast. One waiting session is named
     * plainly; with several, the one whose request arrived last is named with its count
     * — the others are still visible in the dock's aggregate card.
     */
    function otherWaitingBody(rows, entry, t, again) {
      const list = Array.isArray(rows) ? rows : [];
      const nameOf = function (item) {
        return item !== null && item !== undefined && typeof item.title === 'string' && item.title !== ''
          ? item.title
          : '会话 …' + String(item?.sessionId).slice(-6);
      };
      if (list.length <= 1) {
        return again === true
          ? t('dock.otherWaitingAgainOne', { title: nameOf(entry) })
          : t('dock.otherWaitingOne', { title: nameOf(entry) });
      }
      let newest = list[0];
      for (const item of list) {
        if ((Number(item?.oldest) || 0) >= (Number(newest?.oldest) || 0)) newest = item;
      }
      return again === true
        ? t('dock.otherWaitingAgainBody', { title: nameOf(newest), n: Number(newest?.count) || 0 })
        : t('dock.otherWaitingBody', { title: nameOf(newest), n: Number(newest?.count) || 0 });
    }

    /** Another session is waiting on you: toast once per new arrival, never per poll. */
    function noticeOtherPending(list, t) {
      for (const entry of Array.isArray(list) ? list : []) {
        const key = String(entry.sessionId) + '|' + String(entry.oldest) + '|' + String(entry.count);
        if (seenPending.has(key)) continue;
        seenPending.add(key);
        const body = otherWaitingBody(list, entry, t, false);
        toast(t('dock.otherWaitingTitle'), body);
        // Still waiting 20s later means the human is away: say it again and keep this
        // one in the notification centre instead of letting it fade out.
        setTimeout(function () {
          const still = (store.otherPending || []).some(function (row) { return row.sessionId === entry.sessionId; });
          if (still !== true) return;
          toast(
            t('dock.otherWaitingTitle'),
            otherWaitingBody(store.otherPending, entry, t, true),
            { sticky: true, key: entry.sessionId },
          );
        }, 20000);
      }
      if (seenPending.size > 400) seenPending.clear();
    }

    /** Looking at the window? The native panel is right there — a toast would duplicate it. */
    function windowIsFocused() {
      try {
        if (typeof document === 'undefined') return false;
        if (document.visibilityState !== 'visible') return false;
        return typeof document.hasFocus === 'function' ? document.hasFocus() : true;
      } catch (error) {
        return false;
      }
    }

    function noticePending(rows, t) {
      if (windowIsFocused() === true) return;
      // The list itself is on screen: the request is already in front of you.
      if (store.pageVisible === true) return;
      for (const row of rows) {
        const key = String(row.id);
        if (seenPending.has(key)) continue;
        if (row.aiReviewed === false) continue;
        seenPending.add(key);
        const what = String(row.toolName || '') + ' · ' + String(row.argsSummary || row.reason || '').slice(0, 120);
        const reason = typeof row.aiReason === 'string' ? row.aiReason.slice(0, 120) : '';
        const risk = String(row.aiRisk || 'unknown');
        const body = reason === ''
          ? what
          : t('dock.pendingAi', { risk: risk, reason: reason }) + ' · ' + what;
        toast(t('dock.pending'), body);
      }
      if (seenPending.size > 200) seenPending.clear();
    }

    /**
     * Decide whether a freshly seen row deserves a dock hint. Pending rows are the
     * other half of the story and are polled separately (no session filter), because
     * the composer dock has no session id of its own.
     */
    function considerRows(rows) {
      for (const row of rows) {
        const key = String(row.id);
        if (hinted.has(key)) continue;
        hinted.add(key);
        if (row.decidedBy === 'ai') pushHint('ai', row);
        else if (row.decidedBy === 'memory') pushHint('memory', row);
      }
      if (hinted.size > 400) hinted.clear();
    }

    async function loadConfig() {
      try {
        const body = await api('/config');
        if (isPlainObject(body)) {
          store.config = body;
          notify();
        }
      } catch (error) {
        /* the panel still renders with defaults */
      }
    }

    async function saveConfig(patch) {
      const body = await postJson('/config', patch);
      if (isPlainObject(body)) {
        store.config = body;
        notify();
      }
      return body;
    }

    /**
     * @param force - bypass the 3s throttle.
     * @param sessionArg - whose counts to read; defaults to the current session. The
     *   caller passes it explicitly on a switch, because an effect can run before
     *   `store.sessionId` is updated and would otherwise fetch the session just left.
     */
    async function loadMemory(force, sessionArg) {
      const session = typeof sessionArg === 'string' && sessionArg !== '' ? sessionArg : store.sessionId;
      if (session === '') return;
      const now = Date.now();
      if (force !== true && store.memory !== null && store.memorySid === session && now - memoryAt < 3000) return;
      memoryAt = now;
      try {
        const body = await api('/memory?session=' + encodeURIComponent(session));
        // A late answer for a session we already left must not overwrite the count.
        if (isPlainObject(body) === false || session !== store.sessionId) return;
        store.memory = body;
        store.memorySid = session;
        void loadFiles(session);
        notify();
      } catch (error) {
        /* memory panel is optional */
      }
    }

    /** File-level counters for the session on screen (see ROUTES.files). */
    async function loadFiles(sessionArg) {
      const session = typeof sessionArg === 'string' && sessionArg !== '' ? sessionArg : store.sessionId;
      if (session === '') return;
      try {
        const body = await api('/files?session=' + encodeURIComponent(session));
        if (isPlainObject(body) === false || session !== store.sessionId) return;
        store.files = Array.isArray(body.files) ? body.files : [];
        store.filesError = false;
        notify();
      } catch (error) {
        store.filesError = true;
        notify();
      }
    }

    /**
     * Memory rows for the session on screen. Entries carry their own session key, so
     * a list fetched for another session is filtered out instead of shown as this
     * session's count (the "43 → 0" bug).
     */
    function memoryRows() {
      if (isPlainObject(store.memory) === false) return [];
      if (store.memorySid !== store.sessionId) return [];
      const rows = Array.isArray(store.memory.entries) ? store.memory.entries : [];
      const sid = store.sessionId;
      if (sid === '') return rows;
      const prefix = sid + '\u0000';
      return rows.filter(function (row) { return typeof row.key === 'string' && row.key.indexOf(prefix) === 0; });
    }

    /**
     * Read one approval's write-ahead snapshot diff. Never throws into render.
     * @param callId - the approval whose snapshot to read.
     * @param inline - render under the row instead of in the right sidebar.
     */
    async function loadDiff(callId, inline) {
      if (typeof callId !== 'string' || callId === '') return;
      const already = store.diff !== null && store.diff.callId === callId && store.diff.loading !== true;
      if (already === true && inline === true) {
        // Inline panel under the row: the second click closes it.
        store.diff = null;
        store.revertArmed = '';
        notify();
        return;
      }
      if (already === true) {
        // Sidebar tab: the tab IS the surface, so a second click only re-focuses it.
        // Clearing the state here is what sent the pane back to the conversation.
        return;
      }
      store.revertArmed = '';
      store.diff = { callId: callId, loading: true, data: null, message: null, reverting: false, inline: inline === true };
      notify();
      try {
        const body = await api('/diff?session=' + encodeURIComponent(store.sessionId) + '&callId=' + encodeURIComponent(callId));
        store.diff = { callId: callId, loading: false, data: isPlainObject(body) ? body : { ok: false, reason: 'failed' }, message: null, reverting: false, inline: inline === true };
      } catch (error) {
        store.diff = { callId: callId, loading: false, data: { ok: false, reason: 'failed' }, message: null, reverting: false, inline: inline === true };
      }
      notify();
    }

    /**
     * Where a diff opens: the right sidebar when the host has one, otherwise under
     * the row. The row itself never decides — this does, once, at click time.
     */
    async function openDiff(callId) {
      const inline = sideAvailable !== true;
      await loadDiff(callId, inline);
      if (inline === false && typeof sideOpen === 'function') sideOpen();
    }

    /** One stray click must not throw a file away: arm on the first click, run on the second. */
    function armRevert(callId) {
      if (typeof callId !== 'string' || callId === '') return;
      if (revertArmTimer !== null) {
        clearTimeout(revertArmTimer);
        revertArmTimer = null;
      }
      if (store.revertArmed === callId) {
        store.revertArmed = '';
        notify();
        void revertDiff(callId);
        return;
      }
      store.revertArmed = callId;
      revertArmTimer = setTimeout(function () {
        revertArmTimer = null;
        if (store.revertArmed !== '') {
          store.revertArmed = '';
          notify();
        }
      }, REVERT_CONFIRM_MS);
      notify();
    }

    /** Undo is an instruction to the agent; this plugin writes no files itself. */
    async function revertDiff(callId) {
      if (store.diff === null) return;
      store.diff = Object.assign({}, store.diff, { reverting: true, message: null });
      notify();
      try {
        const body = await postJson('/revert', { session: store.sessionId, callId: callId });
        const ok = isPlainObject(body) && body.ok === true;
        const reason = isPlainObject(body) && body.reason !== void 0 ? body.reason : 'failed';
        store.diff = Object.assign({}, store.diff, { reverting: false, message: ok ? 'reverted' : (reason === 'no-agent' ? 'noAgent' : 'failed') });
      } catch (error) {
        store.diff = Object.assign({}, store.diff, { reverting: false, message: 'failed' });
      }
      notify();
    }

    /** The inline unified diff: dual line numbers, one block per hunk. */
    function renderDiff(t, view) {
      const state = view.diff;
      if (state === null) return null;
      const data = state.data;
      // Revert only exists once there is something to revert *and* we can see it: a
      // button that appears while the diff is still loading invites a blind undo. The
      // tab itself is the close affordance, so there is no "hide" button either.
      const ready = state.loading !== true && data !== null && data.ok === true;
      const lines = [];
      lines.push(h('div', { className: 'ah-diff-head', key: 'head' },
        h('span', { className: 'ah-args', style: { flex: '1 1 auto' } }, ready ? String(data.path || '') : ''),
        ready ? h('button', {
          type: 'button',
          className: 'ah-btn ah-btn-danger',
          key: 'revert',
          disabled: state.reverting === true,
          onClick: function () { armRevert(state.callId); },
        }, view.revertArmed === String(state.callId) ? t('diff.revertConfirm') : t('diff.revert')) : null
      ));
      if (state.loading === true) {
        lines.push(h('div', { className: 'ah-hint', key: 'loading' }, t('diff.loading')));
      } else if (data === null || data.ok !== true) {
        const reason = data === null ? 'failed' : String(data.reason || 'failed');
        const text = reason === 'no-snapshot' ? t('diff.noSnapshot')
          : (reason === 'binary' ? t('diff.binary')
            : (reason === 'too-large' ? t('diff.tooLarge')
              : (reason === 'no-after' ? t('diff.noAfter') : t('diff.failed'))));
        lines.push(h('div', { className: 'ah-hint', key: 'reason' }, text));
      } else {
        const stats = isPlainObject(data.stats) ? data.stats : {};
        lines.push(h('div', { className: 'ah-hint', key: 'stats' }, t('diff.stats', {
          add: Number(stats.add) || 0,
          del: Number(stats.del) || 0,
          unchanged: Number(stats.unchanged) || 0,
        })));
        if (data.drifted === true) lines.push(h('div', { className: 'ah-hint', key: 'drifted' }, t('diff.drifted')));
        const hunks = Array.isArray(data.hunks) ? data.hunks : [];
        for (const hunk of hunks) {
          const hunkLines = Array.isArray(hunk.lines) ? hunk.lines : [];
          // diff.js reports { kind, noOld, noNew, text } per line and only the two
          // start numbers per hunk; the counts are derived here.
          const oldLines = hunkLines.filter(function (line) { return line.noOld !== null && line.noOld !== undefined; }).length;
          const newLines = hunkLines.filter(function (line) { return line.noNew !== null && line.noNew !== undefined; }).length;
          lines.push(h('div', { className: 'ah-hunk', key: 'h-' + String(hunk.oldStart) + '-' + String(hunk.newStart) },
            h('div', { className: 'ah-hunk-head' },
              '@@ -' + String(hunk.oldStart) + ',' + String(oldLines) + ' +' + String(hunk.newStart) + ',' + String(newLines) + ' @@')));
          for (let index = 0; index < hunkLines.length; index += 1) {
            const line = hunkLines[index];
            const kind = typeof line.kind === 'string' ? line.kind : 'ctx';
            const sign = kind === 'add' ? '+' : (kind === 'del' ? '-' : ' ');
            lines.push(h('div', {
              className: 'ah-diff-line ah-diff-' + kind,
              key: 'l-' + String(index) + '-' + String(line.noOld) + '-' + String(line.noNew),
            },
              h('span', { className: 'ah-diff-no' }, line.noOld === null || line.noOld === undefined ? '' : String(line.noOld)),
              h('span', { className: 'ah-diff-no' }, line.noNew === null || line.noNew === undefined ? '' : String(line.noNew)),
              h('span', { className: 'ah-diff-sign' }, sign),
              h('span', { className: 'ah-diff-text' }, String(line.text === undefined || line.text === null ? '' : line.text))
            ));
          }
        }
      }
      if (state.message !== null) {
        lines.push(h('div', { className: 'ah-hint', key: 'msg' }, t('diff.' + state.message)));
      }
      return h('div', { className: 'ah-diff', key: 'diff-' + String(state.callId) }, lines);
    }

    async function memoryManage(payload) {
      const body = await postJson('/memory', payload);
      if (isPlainObject(body)) {
        store.memory = body;
        store.memorySid = store.sessionId;
        notify();
      }
    }

    async function download(format, scope) {
      const session = store.sessionId;
      const url = API_BASE + '/export?format=' + format + '&scope=' + scope + (scope === 'all' ? '' : '&session=' + encodeURIComponent(session));
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok !== true) return false;
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        // Prefer the server's RFC 5987 name: it carries the session title.
        const disposition = response.headers.get('content-disposition') || '';
        const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
        const plain = /filename="([^"]+)"/i.exec(disposition);
        anchor.download = encoded !== null
          ? decodeURIComponent(encoded[1])
          : (plain !== null ? plain[1] : 'review-hub-' + scope + '.' + format);
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 1000);
      }
      return true;
    }

    // ─── 04 · 样式 ─────────────────────────────────────────────────
    const CSS = [
      // The dock now sits in conversation.input.dock, the row above the input:
      // same width as the composer, so it reads as part of it instead of floating.
      // One palette for the three decisions, taken from the theme's own pale
      // "tertiary" fills: change these four lines and every card, chip and dot follows.
      '.ah-dock,.ah-view,.ah-preview,.ah-float{--ah-ai-fg:var(--dsw-alias-state-success-primary,#2fa84f);--ah-ai-bg:var(--dsw-alias-state-success-tertiary,rgba(47,168,79,.12));--ah-memory-fg:var(--dsw-alias-state-business-primary,#2f6fd0);--ah-memory-bg:var(--dsw-alias-state-business-tertiary,rgba(47,111,208,.12));--ah-human-fg:#f7ad31;--ah-human-bg:rgba(247,173,49,.14);--ah-card-bg:var(--dsw-specific-input-major,#2c2c2e)}',
      // The host's approval panel takes over `conversation.composer` and lays itself out
      // as `_root{padding:8px calc(side-clearance + 16px) 12px}` > `_card{width:100%;
      // max-width:--dsh-chat-content-width}`. Copying that container byte for byte is
      // what makes our row sit in the same column as the card below it.
      '.ah-dock{box-sizing:border-box;flex:none;width:100%;max-width:calc(var(--dsh-chat-content-width,920px) + (var(--dsh-composer-side-clearance,16px) + 16px) * 2);margin:0 auto;display:flex;flex-direction:column;gap:4px;padding:2px calc(var(--dsh-composer-side-clearance,16px) + 16px)}',
      '.ah-card{box-sizing:border-box;display:flex;align-items:center;gap:8px;padding:8px 10px;min-height:44px;border-radius:10px;font-size:12px;line-height:18px;border:1px solid var(--dsw-alias-border-l2);background:var(--ah-card-bg,#2c2c2e);color:var(--dsw-alias-label-primary)}',
      // One flat green for the AI family across every card surface (product decision).
      '.ah-dock,.ah-preview,.ah-float,.ah-card-ai,.ah-card-chip-ai{--ah-ai-fg:#65c98d}',
      /* The reviewing card carries two lines; keep the break instead of folding it away. */
      '.ah-float .ah-card-sub,.ah-preview .ah-card-sub{white-space:pre-line}',
      '.ah-card-ai{border-color:color-mix(in srgb, var(--ah-ai-fg) 55%, transparent)}',
      '.ah-card-memory{border-color:color-mix(in srgb, var(--ah-memory-fg) 50%, transparent)}',
      '.ah-card-pending{border-color:color-mix(in srgb, var(--ah-human-fg) 60%, transparent)}',
      '.ah-card-other{border-style:dashed;border-color:color-mix(in srgb, #ffffff 32%, transparent);opacity:.92}',
      // Another session is information, not a task: the text carries the weight, the
      // chip keeps its own voice.
      '.ah-card-other .ah-card-main,.ah-card-other .ah-card-sub{font-weight:600}',
      '.ah-preview{display:flex;flex-direction:column;gap:6px;margin:4px 0 2px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}',
      '.ah-preview-btns{display:flex;flex-wrap:wrap;gap:6px}',
      '.ah-card-chip{flex:none;font-size:10px;line-height:16px;font-weight:600;padding:1px 8px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}',
      // The verdict chip speaks in the same colour the rest of the card does.
      '.ah-card-chip-ai{background:var(--ah-ai-bg);color:var(--ah-ai-fg)}',
      '.ah-card-chip-memory{background:var(--ah-memory-bg);color:var(--ah-memory-fg)}',
      '.ah-card-chip-pending{background:var(--ah-human-bg);color:var(--ah-human-fg)}',
      '.ah-card-chip-danger{background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#d93a3a) 16%, transparent);color:var(--dsw-alias-state-error-primary,#d93a3a)}',
      '.ah-ring{flex:none;display:inline-flex;align-items:center;justify-content:center;line-height:0;color:inherit;opacity:.9}',
      '.ah-ring-track{fill:none;stroke:currentColor;stroke-width:1.5;opacity:.3}',
      '.ah-ring-arc{fill:none;stroke:currentColor;stroke-width:3.5;stroke-dasharray:31.416;transform:rotate(-90deg);transform-origin:8px 8px;animation-name:ah-ring-drain;animation-timing-function:linear;animation-fill-mode:forwards}',
      '@keyframes ah-ring-drain{from{stroke-dashoffset:0}to{stroke-dashoffset:31.416}}',
      '.ah-card-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.ah-card-main{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ah-card-sub{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ah-icon-btn{position:relative;flex:none;line-height:0;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#9aa0a6);cursor:pointer;opacity:.78;transition:opacity 120ms ease,background 120ms ease}',
      '.ah-icon-btn svg{display:block;margin:auto}',
      '.ah-icon-btn:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));color:var(--dsw-alias-label-primary)}',
      '.ah-icon-ok{color:var(--ah-ai-fg);opacity:1}',
      '.ah-icon-on{color:var(--ah-memory-fg);opacity:1}',
      // Collapsed while a filter is still applied: the icon has to say the list is cut.
      '.ah-icon-filtered{color:var(--dsw-alias-state-business-primary,#2f6fd0);opacity:1}',
      '.ah-icon-filtered::after{content:"";position:absolute;top:3px;right:3px;width:5px;height:5px;border-radius:999px;background:currentColor}',
      '.ah-card-danger{border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary,#d93a3a) 65%, transparent)}',
      '.ah-stat-line{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#b6bcc4);word-break:break-word}',
      '.ah-stat-lane{display:flex;flex-direction:column;gap:1px;padding:4px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.14))}',
      '.ah-stat-lane-name{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11.5px;color:var(--dsw-alias-label-primary)}',
      '.ah-motto{text-align:center;font-size:12px;line-height:19px;margin:2px 0 6px;color:var(--dsw-alias-label-tertiary,#9aa0a6)}',
      '.ah-row-waiting{opacity:.92}',
      '.ah-band{display:flex;align-items:center;gap:8px;margin:8px 12px 0;padding:6px 10px;border-radius:9px;border:1px solid color-mix(in srgb, var(--ah-human-fg,#d9a521) 40%, transparent);background:color-mix(in srgb, var(--ah-human-bg,rgba(217,165,33,.18)) 60%, transparent)}',
      '.ah-band-danger{border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary,#d93a3a) 45%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#d93a3a) 10%, transparent)}',
      '.ah-band-chip{flex:none;font-size:10px;line-height:16px;font-weight:600;padding:1px 8px;border-radius:9px;background:rgba(128,128,128,.18)}',
      '.ah-band-text{flex:1 1 auto;min-width:0;font-size:11.5px;line-height:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ah-switch{flex:none;position:relative;width:32px;height:18px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-border-l2,rgba(128,128,128,.4));cursor:pointer;transition:background 140ms ease}',
      '.ah-switch-on{background:var(--dsw-alias-state-business-primary,#2f6fd0)}',
      '.ah-switch-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:999px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform 140ms ease}',
      '.ah-switch-on .ah-switch-knob{transform:translateX(14px)}',
      // Body-level, so no host surface can cover it.
      '.ah-float{position:fixed;top:76px;left:50%;transform:translateX(-50%);z-index:2147483000;box-sizing:border-box;width:min(calc(var(--dsh-chat-content-width,920px) + (var(--dsh-composer-side-clearance,16px) + 16px) * 2),calc(100vw - 36px));display:flex;flex-direction:column;gap:4px;padding:8px calc(var(--dsh-composer-side-clearance,16px) + 16px);border-radius:10px;border:1px solid color-mix(in srgb, var(--ah-human-fg,#d9a521) 60%, transparent);background:var(--dsw-alias-bg-layer-1,#17181a);box-shadow:0 8px 24px rgba(0,0,0,.32);font-size:12px;line-height:17px;color:var(--dsw-alias-label-primary)}',
      '.ah-float.ah-float-danger{border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary,#d93a3a) 70%, transparent)}',
      '.ah-float-head{display:flex;align-items:center;gap:8px}',
      '.ah-float-close{margin-left:auto;font-size:14px}',
      '.ah-float-main{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11.5px;color:var(--dsw-alias-label-secondary,#b6bcc4)}',
      // Body colour, not the AI green: on the floating card the advice is the text, and
      // `--dsw-alias-label-primary` is what flips with the theme (white ⇄ ink).
      '.ah-float-sub{overflow-wrap:anywhere;color:var(--dsw-alias-label-primary,#ffffff)}',
      '.ah-divider{display:flex;align-items:center;gap:8px;padding:6px 12px;color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:11px}',
      '.ah-divider::before,.ah-divider::after{content:"";flex:1 1 auto;height:1px;background:var(--dsw-alias-border-l2)}',
      '.ah-divider-text{flex:none}',
      '.ah-section{margin:10px 0 2px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:4px}',
      '.ah-settings-note{display:block;font-size:11px;line-height:15px;font-weight:400;color:var(--dsw-alias-label-tertiary,#9aa0a6)}',
      '.ah-input-num{max-width:120px}',
      '.ah-view{position:absolute;inset:0;box-sizing:border-box;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);overflow:hidden;z-index:2}',
      '.ah-bar{flex:none;display:flex;align-items:center;gap:6px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.ah-bar-spacer{flex:1 1 auto}',
      '.ah-bar-text{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:8px;overflow:hidden;padding-right:12px}',
      '.ah-bar-chunk{flex:0 0 auto;white-space:nowrap}',
      '.ah-bar .ah-btn{flex:none;white-space:nowrap}',
      // A right sidebar halves this pane. The counts and the lane line are the first
      // things to go: they are read-once text, the buttons next to them are not.

      '.ah-btn{height:24px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}',
      '.ah-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.ah-btn-active{border-color:var(--dsw-alias-state-business-primary,#2f6fd0);color:var(--dsw-alias-state-business-primary,#2f6fd0)}',
      '.ah-btn-danger{color:var(--dsw-alias-state-error-primary,#d93a3a);border-color:var(--dsw-alias-state-error-primary,#d93a3a)}',
      '.ah-filter{flex:none;display:flex;flex-direction:column;gap:6px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:12px}',
      '.ah-filter-row{display:flex;align-items:center;gap:6px;min-width:0}',
      '.ah-filter-row .ah-input,.ah-filter-row .ah-time{flex:1 1 auto;min-width:0}',
      '.ah-filter-row .ah-btn{flex:none;white-space:nowrap}',
      '.ah-filter-row .ah-filter-tool{flex:0 0 auto;width:auto;min-width:76px;max-width:132px;padding:0 4px}',
      '.ah-filter-count{flex:none;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#9aa0a6)}',
      '.ah-filter-count-short{display:none}',
      '.ah-view{container-type:inline-size}',
      '@container (max-width:760px){.ah-filter-count-long{display:none}.ah-filter-count-short{display:inline}}',
      '.ah-filter[hidden]{display:none}',
      '.ah-input{flex:1 1 auto;min-width:0;height:26px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;font-size:12px}',
      'select.ah-input{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1,#fff)}',
      '.ah-input option{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2,#fff)}',
      '.ah-input option:disabled{color:var(--dsw-alias-label-tertiary,#9aa0a6)}',
      '.ah-time{height:26px;padding:0 6px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;font-size:12px}',
      '.ah-time::-webkit-calendar-picker-indicator{border-radius:6px;padding:2px;cursor:pointer;opacity:.7}',
      '.ah-time::-webkit-calendar-picker-indicator:hover{opacity:1;background:var(--dsw-alias-bg-layer-2)}',
      // The composer overlays the pane bottom: leave enough room that the last row can
      // still be scrolled above it instead of sitting under the input box.
      '.ah-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:4px 0 200px}',
      '.ah-view,.ah-dock{font-family:var(--ds-font-family-text,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",system-ui,sans-serif);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}',
      '.ah-row{position:relative;display:flex;gap:8px;padding:8px 12px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18))}',
      '.ah-rail{flex:none;width:14px;display:flex;flex-direction:column;align-items:center;gap:2px;padding-top:1px}',
      '.ah-rail-glyph{flex:none;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;background:none;font-size:12px}',
      '.ah-ink-ok{color:var(--ah-ai-fg,#2fa84f)}',
      '.ah-ink-learn{color:var(--ah-memory-fg,#2f6fd0)}',
      '.ah-ink-warn{color:var(--ah-human-fg,#f7ad31)}',
      '.ah-ink-danger{color:var(--dsw-alias-state-error-primary,#d93a3a)}',
      '.ah-ink-muted{color:var(--dsw-alias-label-tertiary,#9aa0a6)}',
      '.ah-rail-line{flex:1 1 auto;width:1px;min-height:6px;background:var(--dsw-alias-border-l2,rgba(128,128,128,.28))}',
      '.ah-row:last-child .ah-rail-line{display:none}',
      '.ah-tool{flex:0 1 auto;display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.16));font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      // The buttons hang off the command block itself: same bottom line as the code.
      '.ah-main{position:relative}',
      // Only the command line shares its row with the buttons; the first line owns the
      // full width, which is what lets the date sit on the right edge.
      '.ah-main .ah-line + .ah-line{padding-right:78px}',
      '.ah-row-actions{position:absolute;right:0;bottom:-7px;display:flex;align-items:center;gap:2px}',
      '.ah-row-reason{margin-top:4px;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12));font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#b6bcc4);white-space:pre-wrap;overflow-wrap:anywhere}',
      // The reviewer's reason is its own paragraph: a hairline separates "what the caller
      // said" from "why the reviewer stopped it", so neither can be mistaken for the other.
      '.ah-row-reason-ai{margin-top:5px;padding-top:5px;border-top:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.22))}',
      '.ah-row-reason-head{display:flex;align-items:center;gap:6px}',
      '.ah-risk{font-size:10.5px;line-height:15px;white-space:nowrap}',
      '.ah-risk-high{color:var(--dsw-alias-state-error-primary,#d93a3a)}',
      '.ah-risk-medium{color:var(--ah-human-fg,#f7ad31)}',
      '.ah-risk-low{color:var(--ah-ai-fg,#2fa84f)}',
      '.ah-risk-unknown{color:var(--dsw-alias-label-tertiary,#9aa0a6)}',
      '.ah-row-reason-ai-solo{margin-top:0;padding-top:0;border-top:0}',
      '.ah-row-reason-label{color:var(--dsw-alias-label-primary,#fff)}',
      '.ah-row-model{flex:0 1 auto;min-width:0;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6)}',
      // "AI 打回" is a property of the row, not of the AI lane: the chip already carries the
      // row's tone (warn / muted / danger), so the prefix inherits that colour instead of
      // pinning the AI green — otherwise "AI 打回 · 人工拒绝" paints green next to red.
      '.ah-chip-pre{color:inherit;font-weight:600}',
      '.ah-chip{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;padding:1px 6px;border-radius:999px;border:1px solid transparent}',
      '.ah-chip-short{display:none}',
      // A right sidebar halves this pane; the tool name and the date must never lose.
      '@container (max-width:560px){.ah-chip-long{display:none}.ah-chip-short{display:inline}}',
      // Narrower than the sidebar itself: drop the reviewer verdict, then the unit word,
      // then the whole memory sentence — the decision stays on screen the longest because
      // it is the only group that says what actually happened.
      '@container (max-width:560px){.ah-chip-pre{display:none}}',
      '@container (max-width:560px){.ah-chip-mem-pre{display:none}}',
      '@container (max-width:480px){.ah-chip-mem-unit{display:none}}',
      '@container (max-width:400px){.ah-chip-mem{display:none}}',
      '.ah-tone-warn{color:var(--ah-human-fg,#f7ad31);background:var(--ah-human-bg,rgba(247,173,49,.14));border-color:transparent}',
      '.ah-tone-ok{color:var(--ah-ai-fg,#2fa84f);background:var(--ah-ai-bg,rgba(47,168,79,.12));border-color:transparent}',
      '.ah-tone-learn{color:var(--ah-memory-fg,#2f6fd0);background:var(--ah-memory-bg,rgba(47,111,208,.12));border-color:transparent}',
      '.ah-tone-danger{color:var(--dsw-alias-state-error-primary,#d93a3a)}',
      '.ah-tone-muted{color:var(--dsw-alias-label-tertiary,#9aa0a6)}',
      '.ah-time-stamp{flex:0 0 auto;align-self:flex-start;margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6)}',
      // The lane and its date are one unit: the group takes the free space, not the date.
      // Deliberately NOT flex — a flex container trims the spaces around "·" (so the copy
      // text read "x0.00·11-08") and puts each item on its own line when copied.
      '.ah-row-stamp{flex:0 1 auto;min-width:0;margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6)}',
      '.ah-row-stamp .ah-row-model{max-width:none;font-size:11px}',
      '.ah-row-stamp .ah-time-stamp{margin-left:0;align-self:auto}',
      '.ah-row-sep{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6)}',
      '.ah-lane-model-short{display:none}',
      // Three widths, three things to give up — in the order they stop paying rent.
      // Tuned low on purpose: the pane still has room at these sizes, and a label that
      // shortens while it fits reads as a bug.
      '@container (max-width:520px){.ah-lane-price{display:none}}',
      '@container (max-width:450px){.ah-lane-provider{display:none}}',
      '@container (max-width:400px){.ah-lane-model-long{display:none}.ah-lane-model-short{display:inline}}',
      '.ah-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.ah-line{display:flex;align-items:center;gap:6px;min-width:0}',
      '.ah-main .ah-args{flex:0 1 auto;min-width:0}',
      '.ah-args{flex:1 1 auto;min-width:0;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#b6bcc4);white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;}',
      '.ah-line{min-width:0}',
      '.ah-chip{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.16))}',
      '.ah-empty{padding:24px 16px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0a6)}',
      '.ah-settings-tab .ah-settings{max-height:none;overflow:visible;margin:0;border:0;background:transparent;padding:2px 0}',
      '.ah-settings{margin:10px 12px;max-height:min(62vh,560px);overflow-y:auto;overscroll-behavior:contain;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:10px 12px;display:flex;flex-direction:column;gap:8px;font-size:12px}',
      '.ah-settings-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.ah-settings-row.ah-settings-stack{flex-direction:column;align-items:stretch;gap:3px}',
      '.ah-textarea{height:auto;min-height:56px;padding:6px 8px;line-height:17px;white-space:pre-wrap;overflow-wrap:anywhere;resize:vertical;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace)}',
      // A switch belongs on the title row, not pushed below a long note: the note is
      // prose about the switch, so it reads under the title while the switch stays put.
      '.ah-settings-row.ah-settings-toggle{align-items:flex-start;flex-wrap:nowrap}',
      '.ah-settings-toggle .ah-settings-label{min-width:0;padding-right:6px}',
      '.ah-settings-toggle .ah-switch{margin-top:1px}',
      '.ah-settings-label{flex:1 1 auto;min-width:120px;display:flex;flex-direction:column;gap:1px}',
      '.ah-danger-title{font-weight:600;color:var(--dsw-alias-state-error-primary,#d93a3a)}',
      '.ah-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6)}',
      '.ah-panel{box-sizing:border-box;height:100%;min-height:0;overflow-y:auto;padding:10px 12px 48px;display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}',
      '.ah-memory{display:flex;flex-direction:column;gap:4px;padding:6px 12px}',
      '.ah-memory-pane{display:flex;flex-direction:column;gap:6px;padding:0}',
      // `field-sizing:fixed` is what stops the box growing as you type; the min/max pair
      // keeps a column flex parent from stretching it either.
      '.ah-memory-search{flex:1 1 auto;min-width:0;height:28px;min-height:28px;max-height:28px;field-sizing:fixed;font-size:12.5px;padding:0 10px}',
      '.ah-mem-group{display:flex;flex-direction:column;gap:2px;padding:2px 0 6px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.14))}',
      '.ah-mem-group-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;width:100%;padding:4px 0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;border-radius:6px}',
      '.ah-mem-group-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}',
      '.ah-delta{flex:0 0 auto;display:inline-flex;align-items:center;gap:5px;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;font-variant-numeric:tabular-nums}',
      '.ah-delta-add{color:var(--dsw-alias-state-success-primary,#2fa84f)}',
      '.ah-delta-del{color:var(--dsw-alias-state-error-primary,#d93a3a)}',
      '.ah-mem-progress{flex:0 0 auto;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);font-variant-numeric:tabular-nums}',
      '.ah-mem-files{display:flex;flex-direction:column;gap:2px;padding-top:8px;margin-top:4px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.14))}',
      '.ah-mem-file-row{display:flex;align-items:center;gap:8px;padding:3px 0}',
      '.ah-mem-file-path{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11.5px;color:var(--dsw-alias-label-secondary,#b6bcc4)}',
      '.ah-mem-file-row .ah-switch{margin-left:auto}',
      '.ah-switch[disabled]{opacity:.4;cursor:not-allowed}',
      '.ah-mem-filter{display:flex;align-items:center;gap:6px;flex:none;width:100%;align-self:stretch}',
      '.ah-mem-filter .ah-memory-tool{flex:0 0 20%;min-width:0;height:28px;min-height:28px;max-height:28px;padding:0 6px}',
      '.ah-mem-filter .ah-input option{background:var(--dsw-alias-bg-layer-2,#2c2c2e);color:var(--dsw-alias-label-primary)}',
      '.ah-mem-row-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.ah-mem-actions{flex:none;display:inline-flex;align-items:center;gap:8px;margin-left:auto} ',
      '.ah-mem-group-tool{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.ah-mem-group-meta{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#9aa0a6)}',
      '.ah-mem-row{display:flex;flex-direction:column;gap:2px;padding:5px 0 6px 10px;border-left:2px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2))}',
      '.ah-mem-row-main{font-size:12px;line-height:17px;color:var(--dsw-alias-label-primary)}',
      '.ah-mem-row-sub{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary,#b6bcc4);word-break:break-word;white-space:pre-wrap}',
      '.ah-mem-row-foot{display:flex;align-items:center;gap:8px;padding-top:2px;flex-wrap:wrap}',
      '.ah-memory-pane .ah-memory-row{flex-wrap:wrap;padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.14))}',
      '.ah-memory-pane .ah-args{white-space:normal;word-break:break-word}',
      '.ah-memory-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none}',
      '.ah-memory-tab .ah-memory-pane{flex:1 1 auto;min-height:0}',
      '.ah-memory-row{display:flex;align-items:center;gap:8px;font-size:12px}',
      '.ah-diff{margin:4px 0 2px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);padding:6px 8px;display:flex;flex-direction:column;gap:4px}',
      '.ah-diff-head{display:flex;align-items:center;gap:6px}',
      '.ah-hunk{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}',
      '.ah-hunk-head{color:var(--dsw-alias-label-tertiary,#9aa0a6);padding:2px 0}',
      '.ah-diff-line{display:flex;gap:8px;white-space:pre-wrap;word-break:break-all;border-radius:4px;padding:0 4px}',
      '.ah-diff-add{background:color-mix(in srgb, var(--dsw-alias-state-success-primary,#2fa84f) 14%, transparent)}',
      '.ah-diff-del{background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#d93a3a) 14%, transparent)}',
      '.ah-diff-no{flex:0 0 42px;text-align:right;color:var(--dsw-alias-label-tertiary,#9aa0a6)}',
      '.ah-diff-sign{flex:0 0 8px}',
      '.ah-diff-text{flex:1 1 auto;min-width:0}',
    ].join('');

    /**
     * The dock is the only always-mounted seat, so it owns the real-time channel:
     * one SSE connection per session, with a polling fallback when the stream dies.
     * Everything the 审批 tab shows (rows, unread badge) is fed from here — that is
     * why a badge can appear while the tab is closed.
     */
    /**
     * The counts line, packed by real width: whole chunks from the left until the row
     * is full, then the rest are hidden. Chunks are units, so "放行 3" never renders as
     * a bare "放行", and the buttons to the right never get squeezed.
     */
    function BarText(props) {
      const chunks = Array.isArray(props.chunks) ? props.chunks.filter(function (text) { return typeof text === 'string' && text !== ''; }) : [];
      const hostRef = React.useRef(null);
      const signature = chunks.join('|');
      React.useEffect(function () {
        const host = hostRef.current;
        if (host === null) return undefined;
        // Slack of one gap: sub-pixel widths used to let the last chunk clip a few
        // pixels ("不可用 (" with the number cut off).
        const SLACK = 18;
        const pack = function () {
          const kids = Array.prototype.slice.call(host.children);
          for (const kid of kids) kid.style.display = '';
          const room = host.getBoundingClientRect().width - SLACK;
          let used = 0;
          let cut = kids.length;
          for (let index = 0; index < kids.length; index += 1) {
            const width = kids[index].getBoundingClientRect().width + (index === 0 ? 0 : 8);
            if (used + width > room) { cut = index; break; }
            used += width;
          }
          for (let index = cut; index < kids.length; index += 1) kids[index].style.display = 'none';
        };
        pack();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver(pack);
        observer.observe(host);
        return function () { observer.disconnect(); };
      }, [signature]);
      if (chunks.length === 0) return null;
      return h('div', { className: 'ah-bar-text', ref: hostRef }, chunks.map(function (text, index) {
        return h('span', { className: 'ah-bar-chunk', key: 'chunk-' + String(index) }, text);
      }));
    }
    // ─── 05 · 组件 · HintBar：输入框上方提示卡 + 实时中枢 ─────────
    function HintBar(props) {
      const t = translator(props);
      const view = useStore();
      const copied = React.useRef('');
      const dockRef = React.useRef(null);
      const copyState = React.useState('');
      const copyText = copyState[0];
      const setCopyText = copyState[1];

      // The layout no longer guesses at runtime: the host's own approval container is
      // mirrored in `.ah-dock` (see the CSS comment), so there is nothing to measure.


      // The floating advice card lives on document.body, so it has to be taken down
      // when this seat goes away.
      React.useEffect(function () {
        return function () { removeAdviceOverlay(); };
      }, []);

      React.useEffect(function () {
        const sid = props !== null && typeof props?.sessionId === 'string' ? props.sessionId : '';
        if (sid === '') return undefined;
        let alive = true;
        let source = null;
        let fallbackTimer = null;
        let busy = false;

        store.sessionId = sid;
        // Memory counts belong to one session: without this the toolbar kept showing
        // the session you just left until you clicked the button.
        store.memory = null;
        void loadMemory(true, sid);
        store.seenAt = storageGet('review-hub:seen:' + sid);
        if (store.hintFloorSid !== sid) {
          store.hintFloorSid = sid;
          store.hintFloor = storageGet('review-hub:floor:' + sid);
          store.hintSeeded = '';
        }

        void loadConfig();

        const applyRows = function (rows) {
          if (Array.isArray(rows) === false || rows.length === 0) return;
          store.entries = mergeRows(store.entries, rows);
          for (const row of rows) store.cursor = Math.max(store.cursor, Number(row.ts) || 0);
        };

        const raiseFloor = function (ts) {
          const value = Number(ts) || 0;
          if (value <= store.hintFloor) return;
          store.hintFloor = value;
          storageSet('review-hub:floor:' + sid, value);
        };

        const refreshUnread = function () {
          // This session only: the store outlives a switch, and counting the rows we
          // just left is what kept the badge alive on a session with nothing unread.
          const own = store.entries.filter(function (row) { return row.sessionId === sid; });
          const next = unreadCount(own, store.seenAt);
          if (next !== store.unread) store.unread = next;
          pushTabLabel();
        };
        // Same reason, one step earlier: the previous session's rows are not this page's.
        store.entries = store.entries.filter(function (row) { return row.sessionId === sid; });
        refreshUnread();

        const accumulate = function (payload) {
          if (payload === null || typeof payload !== 'object') return;
          const otherId = String(payload.sessionId || '');
          if (otherId === '' || otherId === sid) return;
          const stamp = Number(payload.ts) || 0;
          const list = store.others.filter(function (item) { return item.sessionId !== otherId; });
          const previous = store.others.find(function (item) { return item.sessionId === otherId; });
          const next = {
            sessionId: otherId,
            title: typeof payload.title === 'string' && payload.title !== '' ? payload.title : (previous && previous.title) || '',
            ai: (previous ? previous.ai : 0) + (payload.decidedBy === 'ai' ? 1 : 0),
            memory: (previous ? previous.memory : 0) + (payload.decidedBy === 'memory' ? 1 : 0),
            human: (previous ? previous.human : 0) + (payload.decidedBy === 'human' ? 1 : 0),
            lastTs: Math.max(previous ? previous.lastTs : 0, stamp),
          };
          store.others = list.concat([next]).sort(function (a, b) { return b.lastTs - a.lastTs; }).slice(0, 4);
          notify();
        };

        const acceptRow = function (row) {
          if (row === null || typeof row !== 'object') return;
          if (typeof row.sessionId === 'string' && row.sessionId !== '' && row.sessionId !== sid) return;
          applyRows([row]);
          if (shouldHint(row, store.hintFloor, hinted)) {
            hinted.add(String(row.id));
            pushHint(row.decidedBy, row);
          }
          if (store.hintSeeded === sid) raiseFloor(row.ts);
          refreshUnread();
          notify();
        };

        const loadOnce = async function () {
          if (busy || alive !== true) return;
          busy = true;
          try {
            const body = await api('/entries?session=' + encodeURIComponent(sid) + '&limit=200');
            if (alive !== true) return;
            const rows = Array.isArray(body && body.entries) ? body.entries : [];
            applyRows(rows);
            if (store.hintSeeded !== sid) {
              // First look at this session: everything here is history. Seed the
              // baseline and the seen-ids set so a later push cannot replay it.
              for (const row of rows) hinted.add(String(row.id));
              let max = store.hintFloor;
              for (const row of rows) max = Math.max(max, Number(row.ts) || 0);
              store.hintFloor = max;
              storageSet('review-hub:floor:' + sid, max);
              store.hintSeeded = sid;
              if (store.seenAt === 0) {
                store.seenAt = max;
                storageSet('review-hub:seen:' + sid, max);
              }
            }
            const pendingBody = await api('/pending?session=' + encodeURIComponent(sid));
            if (alive !== true) return;
            store.pending = Array.isArray(pendingBody && pendingBody.pending) ? pendingBody.pending : [];
            noticePending(store.pending, t);
            const stats = await api('/stats?session=' + encodeURIComponent(sid));
            if (alive !== true) return;
            store.stats = isPlainObject(stats) ? stats : null;
            store.online = true;
          } catch (error) {
            store.online = false;
          } finally {
            busy = false;
            refreshUnread();
            notify();
          }
        };

        const startFallback = function () {
          if (fallbackTimer !== null) return;
          fallbackTimer = setInterval(function () {
            if (typeof document !== 'undefined' && document.hidden === true) return;
            void loadOnce();
          }, 3000);
        };

        const stopFallback = function () {
          if (fallbackTimer === null) return;
          clearInterval(fallbackTimer);
          fallbackTimer = null;
        };

        const openStream = function () {
          if (typeof EventSource !== 'function') {
            startFallback();
            return;
          }
          try {
            source = new EventSource(API_BASE + '/stream?session=' + encodeURIComponent(sid));
          } catch (error) {
            startFallback();
            return;
          }
          source.addEventListener('ready', function () {
            store.streaming = true;
            stopFallback();
            notify();
          });
          source.addEventListener('entry', function (event) {
            try {
              acceptRow(JSON.parse(event.data)?.row);
            } catch (error) {
              /* a malformed frame must not kill the stream */
            }
          });
          // Bursts arrive as one frame; the rows inside are treated one by one so the
          // hint/floor/unread rules stay identical to the single-row path.
          source.addEventListener('entries', function (event) {
            try {
              const rows = JSON.parse(event.data)?.rows;
              if (Array.isArray(rows) === false) return;
              for (const row of rows) acceptRow(row);
            } catch (error) {
              /* same */
            }
          });
          source.addEventListener('other', function (event) {
            try {
              accumulate(JSON.parse(event.data));
            } catch (error) {
              /* same */
            }
          });
          source.addEventListener('pending', function (event) {
            try {
              const data = JSON.parse(event.data);
              if (data === null || typeof data !== 'object') return;
              if (Array.isArray(data.pending) === true) {
                store.pending = data.pending;
                noticePending(store.pending, t);
              }
              if (Array.isArray(data.others) === true) {
                store.otherPending = data.others;
                noticeOtherPending(store.otherPending, t);
              }
              notify();
            } catch (error) {
              /* same */
            }
          });
          source.onerror = function () {
            store.streaming = false;
            startFallback();
            notify();
          };
        };

        // A hidden window does not need live frames: close the stream (no heartbeat
        // wakeups) and catch up with one request when it becomes visible again.
        const onVisibility = function () {
          if (typeof document === 'undefined') return;
          if (document.hidden === true) {
            if (source !== null) {
              try { source.close(); } catch (error) { /* already closed */ }
              source = null;
            }
            store.streaming = false;
            notify();
            return;
          }
          void loadOnce().then(function () {
            if (alive === true && source === null) openStream();
          });
        };
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', onVisibility);
        }

        reportProbe();
        void loadOnce().then(function () {
          if (alive === true) openStream();
        });

        return function () {
          alive = false;
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVisibility);
          }
          stopFallback();
          if (source !== null) {
            try {
              source.close();
            } catch (error) {
              /* already closed */
            }
            source = null;
          }
          store.streaming = false;
        };
      }, [props === null ? '' : props?.sessionId]);

      React.useEffect(function () {
        if (copyText === '') return undefined;
        const timer = setTimeout(function () { setCopyText(''); }, 1500);
        return function () { clearTimeout(timer); };
      }, [copyText]);

      const copyEntry = function (entry) {
        const lines = [
          String(entry.toolName || ''),
          String(commandOf(entry) || reasonOf(entry) || ''),
          typeof entry.aiReason === 'string' ? 'AI 建议：' + entry.aiReason : '',
        ].filter(function (line) { return line !== ''; });
        void copyToClipboard(lines.join('\n')).then(function (ok) {
          setCopyText(ok ? 'copied' : 'copyFailed');
        });
      };

      // Keep the body-level advice card in step with this render; it is what stays
      // visible while the native approval panel covers the dock.
      syncAdviceOverlay(t, describeDockAnchor(dockRef.current));
      if (view.config !== null && view.config.composerHint === false) return null;
      const cards = [];
      // A card belongs to the session that produced it. Only the aggregate "another
      // session" card may speak for someone else; everything else disappears when you
      // switch away and comes back when you switch back.
      const ownSid = typeof props?.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : store.sessionId;
      const belongsHere = function (row) {
        const owner = row !== null && row !== undefined && typeof row.sessionId === 'string' ? row.sessionId : '';
        return owner === '' || owner === ownSid;
      };

      // While the harness is focused the native panel is already showing the request;
      // a second card here would be hidden behind it (and duplicate the question).
      // Same rule for the approval list: if the human is looking at this session's rows,
      // a card repeating them is noise. Other sessions still get their card.
      const listIsOpen = view.pageVisible === true && (view.pageSid === ownSid || ownSid === '');
      // Own the spinner tick here: one timer for as long as any pending row is still being
      // reviewed, cleared as soon as none is — a re-mount can never leave it running.
      const anyReviewing = view.pending.some(function (row) { return belongsHere(row) && row.aiReviewed !== true; });
      // Clicking anywhere inside our card means the human has answered: retire the row at
      // once instead of waiting for the server to drop it (that wait is what made the card
      // come back for a few frames after a decision).
      if (adviceOverlay.clickHooked !== true && typeof document !== 'undefined') {
        adviceOverlay.clickHooked = true;
        document.addEventListener('click', function (event) {
          if (adviceOverlay.currentId === '') return;
          const node = adviceOverlay.node;
          if (node !== null && typeof node.contains === 'function' && node.contains(event.target) === true) {
            adviceOverlay.settled.add(adviceOverlay.currentId);
            if (adviceOverlay.settled.size > 100) adviceOverlay.settled.clear();
          }
        }, true);
      }
      if (anyReviewing === true && reviewSpin.timer === null) {
        reviewSpin.timer = setInterval(function () { reviewSpin.frame += 1; notify(); }, 500);
      } else if (anyReviewing === false && reviewSpin.timer !== null) {
        clearInterval(reviewSpin.timer);
        reviewSpin.timer = null;
      }
      // The reviewer's card must survive the panel being open: while the native panel is on
      // screen the dock row below is the part that gets covered, so the floating card is the
      // only place this signal can live. Advice/high-risk cards still keep the old rule.
      // Every undecided row is carried by the floating card now, panel open or not: the dock
      // row below is exactly the surface the native panel covers, so it can never be the place
      // a warning lives. The dock keeps only finished results.
      if (view.config !== null && view.config.pendingCard === true && adviceOverlay.node === null) {
        for (const row of view.pending) {
          if (belongsHere(row) === false) continue;
          if (dismissed.has(String(row.id))) continue;
          if (adviceOverlay.settled.has(String(row.id))) continue;
          // Every undecided row is drawn here, including the one still being reviewed: the
          // dock-side rendering never materialised, so gating the reviewing card out of this
          // overlay left the reviewer's first seconds with no card at all.

          // Three states, not two: the reviewer is still thinking / it answered / it never
          // answered. The last one must say so plainly instead of spinning forever.
          const reviewing = row.aiReviewed !== true;
          // "Never sent to the reviewer" and "sent but no verdict" are different facts. Only a
          // row that carries an aiSource was actually reviewed; without one there is nothing
          // to report, so the card stays a plain waiting line instead of claiming a timeout.
          // A designed skip is not a failure: say why instead of pretending a verdict is
          // missing.
          const skipped = typeof row.aiSkip === 'string' && row.aiSkip !== '';
          const reviewed = reviewing === false && skipped === false && typeof row.aiSource === 'string' && row.aiSource !== '';
          const failed = reviewed === true && (typeof row.aiReason !== 'string' || row.aiReason === '');
          const waited = Math.max(0, Math.round((Date.now() - (Number(row.startedAt) || Date.now())) / 1000));
          const glyph = reviewSpin.glyphs[reviewSpin.frame % reviewSpin.glyphs.length];
          // A designed skip is recorded in the approval page, not shouted on screen: the
          // human is already being asked, and a card saying "nothing happened" is noise.
          if (skipped === true) continue;
          const advice = skipped === true
            ? t('dock.pendingSkipped', { why: String(row.aiSkip || '') })
            : (reviewing === true
            ? t('dock.pendingReviewing', { sec: waited, spin: glyph })
            : (failed === true
              ? t('dock.pendingFailed')
              : t('dock.pendingAi', { risk: String(row.aiRisk || 'unknown'), reason: row.aiReason })));
          // A failed review is as serious as a hard risk: both get the red card.
          const dangerous = row.riskLevel === 'high' || failed === true;
          // Two independent switches: the advice card and the high-risk card can each be
          // silenced without turning off the plain "waiting for you" line.
          const hasAdvice = typeof row.aiReason === 'string' && row.aiReason !== '';
          if (hasAdvice === true && view.config.aiAdviceCard === false) continue;
          if (hasAdvice === false && dangerous === true && view.config.dangerCard === false) continue;
          cards.push(cardNode({
            key: 'p-' + row.id,
            kind: 'pending',
            danger: dangerous,
            // "Hard risk" and "no verdict" are different stories; the chip must not claim the
            // first when the card is telling the second.
            chip: failed === true ? t('row.aiNoVerdict') : (dangerous === true ? t('row.highRisk') : ''),
            main: String(row.toolName || '') + ' · ' + String(row.argsSummary || row.reason || '').slice(0, 160),
            sub: advice,
            extra: [iconButton('close', t('dock.dismiss'), function () {
              adviceOverlay.settled.add(String(row.id));
              dismissed.add(String(row.id));
              store.pending = store.pending.filter(function (item) { return item.id !== row.id; });
              notify();
            })],
          }));
        }
      }

      for (const hint of view.hints) {
        const entry = hint.entry;
        if (belongsHere(entry) === false) continue;
        const chip = chipOf(entry, t);
        // The countdown sits right next to the close button: it is the same promise,
        // "this card goes away on its own", drawn instead of written.
        const ttl = hintMsOf(hint.kind);
        cards.push(cardNode({
          key: hint.id,
          kind: hint.kind,
          chip: chip.text,
          main: String(entry.toolName || '') + ' · ' + String(entry.argsSummary || reasonOf(entry) || '').slice(0, 160),
          sub: stampOf(entry.ts),
          extra: [
            iconButton('copy', copyText === 'copied' ? t('dock.copied') : (copyText === 'copyFailed' ? t('dock.copyFailed') : t('dock.copy')), function () { copyEntry(entry); }, copyText === 'copied' ? 'ah-icon-ok' : ''),
            ttl > 0 ? countdownRing(ttl, Date.now() - (Number(hint.ts) || Date.now())) : null,
            iconButton('close', t('dock.dismiss'), function () {
              store.hints = store.hints.filter(function (item) { return item.id !== hint.id; });
              notify();
            }),
          ],
        }));
      }

      // Another session can be *waiting* without anything decided yet. The toast comes
      // from otherPending while the card used to come only from decided rows, so a
      // waiting session announced itself out loud and then drew nothing.
      const othersView = new Map();
      for (const other of Array.isArray(view.others) ? view.others : []) othersView.set(other.sessionId, Object.assign({}, other));
      for (const waiting of Array.isArray(view.otherPending) ? view.otherPending : []) {
        const known = othersView.get(waiting.sessionId);
        const cur = known === undefined
          ? { sessionId: waiting.sessionId, title: '', ai: 0, memory: 0, human: 0, lastTs: 0 }
          : known;
        if (cur.title === '' && typeof waiting.title === 'string') cur.title = waiting.title;
        cur.waiting = Number(waiting.count) || 0;
        cur.lastTs = Math.max(Number(cur.lastTs) || 0, Number(waiting.oldest) || 0);
        othersView.set(waiting.sessionId, cur);
      }
      for (const other of othersView.values()) {
        if (Number(other.lastTs) <= view.othersDismissedAt) continue;
        const name = other.title !== '' ? other.title : '会话 …' + String(other.sessionId).slice(-6);
        const counts = [
          t('dock.otherAi', { n: Number(other.ai) || 0 }),
          t('dock.otherMemory', { n: Number(other.memory) || 0 }),
        ];
        if (Number(other.waiting) > 0) counts.unshift(t('dock.otherWaitChip', { n: Number(other.waiting) }));
        if (Number(other.human) > 0) counts.push(t('dock.otherHuman', { n: Number(other.human) }));
        cards.push(cardNode({
          key: 'o-' + other.sessionId,
          kind: 'other',
          chip: t('dock.otherChip'),
          main: name,
          sub: counts.join(' · '),
          extra: [iconButton('close', t('dock.dismiss'), function () {
            store.othersDismissedAt = Date.now();
            notify();
          })],
        }));
      }

      if (cards.length === 0) return null;
      // No approval card on screen: fall back to the stylesheet's composer-width rule.
      return h('div', { className: 'ah-dock', ref: dockRef }, cards);
    }

    /**
     * The reviewer's route in two steps: a provider, then one of its models. An empty
     * first step means "follow the session", which is also what a hand-cleared field
     * means — one behaviour, no hidden default. The menu is only ever what the host
     * reported; a saved lane the report no longer lists stays selectable and flagged,
     * because swapping it silently would change which model reviews the turn.
     */
    function modelField(t, draft, change) {
      const catalog = isPlainObject(store.models) ? store.models : {};
      const providers = Array.isArray(catalog.providers) ? catalog.providers.filter(function (item) {
        return isPlainObject(item) && typeof item.id === 'string' && item.id !== '';
      }) : [];
      const live = isPlainObject(catalog.current) ? catalog.current : null;
      const stored = typeof draft.reviewerModel === 'string' ? draft.reviewerModel : '';
      const box = { flex: '1 1 auto', minWidth: 220, display: 'flex', flexDirection: 'column', gap: 4 };
      // Two lanes, two words: what the next approval resolves to, and — only when it
      // differs — what the last approval actually used.
      const laneOf = function (option) {
        if (isPlainObject(option) === false) return '';
        if (typeof option.provider !== 'string' || option.provider === '') return '';
        if (typeof option.model !== 'string' || option.model === '') return '';
        return option.provider + '/' + option.model;
      };
      const liveLane = laneOf(live);
      const serverNext = laneOf(catalog.next);
      const resolvedNext = serverNext !== '' ? serverNext : (stored !== '' ? stored : liveLane);
      // "上次审批" is the newest ledger row that recorded a lane — never the chat lane,
      // which would name a model this session never actually reviewed anything with.
      const lastApproval = typeof catalog.lastApproval === 'string' ? catalog.lastApproval : '';
      const nextText = resolvedNext === '' ? t('model.nextNone') : t('model.next', { lane: laneLabel(resolvedNext) });
      const lastText = lastApproval === '' ? '' : t('model.last', { lane: laneLabel(lastApproval) });
      if (providers.length === 0 && live === null) {
        return h('div', { className: 'ah-model', style: box }, [
          h('input', {
            className: 'ah-input',
            key: 'input',
            type: 'text',
            placeholder: t('config.modelEmpty'),
            value: stored,
            onChange: function (event) { change('reviewerModel', event.target.value); },
          }),
          h('div', { className: 'ah-hint', key: 'next' }, nextText),
          lastText === '' ? null : h('div', { className: 'ah-hint', key: 'last' }, lastText),
        ]);
      }
      const cut = stored.indexOf('/');
      const pickedProvider = cut > 0 ? stored.slice(0, cut) : '';
      const pickedModel = cut > 0 ? stored.slice(cut + 1) : '';
      const known = providers.some(function (item) { return item.id === pickedProvider; });
      const rows = providers.slice();
      if (pickedProvider !== '' && known === false) rows.push({ id: pickedProvider, name: pickedProvider, models: [] });
      const labelOf = function (item) {
        return typeof item.name === 'string' && item.name !== '' ? item.name : String(item.id);
      };
      const modelsOf = function (providerId) {
        const found = rows.find(function (item) { return item.id === providerId; });
        if (found === undefined || Array.isArray(found.models) === false) return [];
        return found.models.filter(function (model) {
          return isPlainObject(model) && typeof model.id === 'string' && model.id !== '';
        });
      };
      const providerOptions = [h('option', { key: '__auto', value: '' }, t('config.modelAuto'))];
      for (const item of rows) {
        const flag = known === false && item.id === pickedProvider ? '⚠ ' : '';
        providerOptions.push(h('option', { key: item.id, value: item.id }, flag + labelOf(item)));
      }
      const models = pickedProvider === '' ? [] : modelsOf(pickedProvider);
      const modelOptions = [];
      let modelValue = pickedModel;
      let modelLocked = pickedProvider === '';
      if (pickedProvider === '') {
        modelOptions.push(h('option', { key: '__none', value: '' }, t('model.none')));
      } else if (models.length === 0) {
        // The provider answered without a model list: show what was saved, offer nothing.
        modelLocked = true;
        modelOptions.push(h('option', { key: '__none', value: '' }, pickedModel === '' ? t('model.none') : pickedModel));
      } else {
        for (const model of models) modelOptions.push(h('option', { key: model.id, value: model.id }, labelOf(model)));
        if (pickedModel === '') modelValue = models[0].id;
        else if (models.some(function (model) { return model.id === pickedModel; }) === false) {
          modelOptions.push(h('option', { key: pickedModel, value: pickedModel }, pickedModel));
        }
      }
      const fetchedAt = (function () {
        const value = Number(catalog.fetchedAt);
        if (Number.isFinite(value) === false || value <= 0) return '';
        const date = new Date(value);
        const pad = function (part) { return String(part).padStart(2, '0'); };
        return pad(date.getHours()) + ':' + pad(date.getMinutes());
      })();
      const errors = Array.isArray(catalog.errors) ? catalog.errors : [];
      return h('div', { className: 'ah-model', style: box }, [
        h('div', { className: 'ah-model-pick', key: 'pick', style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } }, [
          h('select', {
            className: 'ah-input',
            key: 'provider',
            style: { flex: '0 1 140px' },
            value: pickedProvider,
            onChange: function (event) {
              const next = event.target.value;
              if (next === '') {
                change('reviewerModel', '');
                return;
              }
              const first = modelsOf(next)[0];
              change('reviewerModel', first === undefined ? next + '/' : next + '/' + first.id);
            },
          }, providerOptions),
          h('select', {
            className: 'ah-input',
            key: 'model',
            style: { flex: '0 1 180px' },
            value: modelValue,
            disabled: modelLocked,
            onChange: function (event) { change('reviewerModel', pickedProvider + '/' + event.target.value); },
          }, modelOptions),
          iconButton('refresh', t('model.refresh'), function () { void loadModels(true, { refresh: true }); }),
          fetchedAt === '' ? null : h('span', { className: 'ah-hint', key: 'fetched' }, fetchedAt),
        ]),
        h('div', { className: 'ah-hint', key: 'next' }, nextText),
        lastText === '' ? null : h('div', { className: 'ah-hint', key: 'last' }, lastText),
        errors.length === 0 ? null : h('div', { className: 'ah-hint ah-tone-warn', key: 'errors' }, t('model.skipped', { n: errors.length })),
      ]);
    }

    // ─── 05 · 组件 · SettingsPanel：审批页里的日常设置 ────────────
    function SettingsPanel(props) {
      const t = translator(props);
      const view = useStore();
      // The reviewer-model menu lists lanes this plugin has actually seen. An empty
      // answer keeps the free-text input, so a fresh install is never blocked.
      React.useEffect(function () {
        void loadModels(true);
      }, []);
      const state = React.useState('idle');
      const status = state[0];
      const setStatus = state[1];
      const armed = React.useState(0);
      const clearArmed = armed[0];
      const setClearArmed = armed[1];
      const memArmed = React.useState(0);
      const memoryArmed = memArmed[0];
      const setMemoryArmed = memArmed[1];
      const scope = React.useState('session');
      const exportScope = scope[0];
      const setExportScope = scope[1];

      React.useEffect(function () {
        if (clearArmed === 0) return undefined;
        const timer = setTimeout(function () { setClearArmed(0); }, CONFIRM_RESET_MS);
        return function () { clearTimeout(timer); };
      }, [clearArmed]);

      React.useEffect(function () {
        if (memoryArmed === 0) return undefined;
        const timer = setTimeout(function () { setMemoryArmed(0); }, CONFIRM_RESET_MS);
        return function () { clearTimeout(timer); };
      }, [memoryArmed]);

      const config = isPlainObject(view.config) ? view.config : {};

      const flip = function (field) {
        return async function () {
          setStatus('saving');
          try {
            await saveConfig(Object.assign({}, config, { [field]: config[field] !== true }));
            setStatus('saved');
          } catch (error) {
            setStatus('failed');
          }
        };
      };

      const savePatch = async function (patch) {
        setStatus('saving');
        try {
          await saveConfig(Object.assign({}, config, patch));
          setStatus('saved');
        } catch (error) {
          setStatus('failed');
        }
      };

      // "Do not follow other sessions" is the presence of this session's key, not the
      // truth of a flag: an empty value still means "this session picks its own lane".
      const sid = props !== null && props !== undefined && typeof props.sessionId === 'string' && props.sessionId !== ''
        ? props.sessionId
        : view.sessionId;
      const localTable = isPlainObject(config.reviewerModelLocal) ? config.reviewerModelLocal : {};
      const localPinned = typeof sid === 'string' && sid !== '' && Object.prototype.hasOwnProperty.call(localTable, sid);
      const localValue = localPinned === true && typeof localTable[sid] === 'string' ? localTable[sid] : '';
      // Same idea for the AI switch: a per-session entry wins over the global one.
      const aiLocalTable = config.aiEnabledLocal !== null && typeof config.aiEnabledLocal === 'object' ? config.aiEnabledLocal : {};
      const aiLocalOn = Object.prototype.hasOwnProperty.call(aiLocalTable, sid) ? aiLocalTable[sid] === true : config.aiEnabled === true;
      const globalValue = typeof config.reviewerModel === 'string' ? config.reviewerModel : '';
      const writeModel = async function (patch) {
        await savePatch(patch);
        // The server computes "what the next approval will use" from the saved config.
        void loadModels(true);
      };
      const toggleLocal = async function () {
        if (typeof sid !== 'string' || sid === '') return;
        const table = Object.assign({}, localTable);
        if (localPinned === true) delete table[sid];
        // Turning it on keeps the lane that was in effect: the global pin, or '' = this
        // session's own lane. Turning it off hands the session back to the global pin.
        else table[sid] = localValue !== '' ? localValue : globalValue;
        await writeModel({ reviewerModelLocal: table });
      };
      // While the switch is on the menu shows and writes this session's own value; while
      // it is off both go to the global reviewerModel, exactly as before.
      const modelDraft = localPinned === true ? Object.assign({}, config, { reviewerModel: localValue }) : config;
      const commitModel = function (field, value) {
        if (field !== 'reviewerModel' || localPinned !== true) { void writeModel({ [field]: value }); return; }
        void writeModel({ reviewerModelLocal: Object.assign({}, localTable, { [sid]: value }) });
      };

      /** One switch, host-style: a pill with a knob, never the word 开/关. */
      const row = function (key, label, hint, value, onClick) {
        return h('div', { className: 'ah-settings-row ah-settings-toggle', key: key },
          h('span', { className: 'ah-settings-label' },
            label,
            hint === '' || hint === undefined ? null : h('span', { className: 'ah-settings-note' }, hint)
          ),
          h('button', {
            type: 'button',
            className: 'ah-switch' + (value === true ? ' ah-switch-on' : ''),
            role: 'switch',
            'aria-checked': value === true ? 'true' : 'false',
            title: label,
            onClick: onClick,
          }, h('span', { className: 'ah-switch-knob' }))
        );
      };

      /** A number that commits on blur (typing must not write on every keystroke). */
      const numRow = function (key, label, hint, value, commit, min, max) {
        return h('div', { className: 'ah-settings-row', key: key },
          h('span', { className: 'ah-settings-label' },
            label,
            hint === '' || hint === undefined ? null : h('span', { className: 'ah-settings-note' }, hint)
          ),
          h('input', {
            className: 'ah-input ah-input-num',
            type: 'number',
            min: min,
            max: max,
            defaultValue: value === undefined ? '' : value,
            onBlur: function (event) { void commit(Number(event.target.value)); },
          })
        );
      };

      const hintMsValue = function (kind, fallback) {
        const table = isPlainObject(config.hintMs) ? config.hintMs : {};
        const value = Number(table[kind]);
        return Number.isFinite(value) ? value : fallback;
      };

      const patchHintMs = function (kind, value) {
        const table = isPlainObject(config.hintMs) ? config.hintMs : {};
        return savePatch({ hintMs: Object.assign({}, table, { [kind]: value }) });
      };

      const wipe = async function () {
        const next = clearArmed + 1;
        if (next < CLEAR_CLICKS) {
          setClearArmed(next);
          return;
        }
        setClearArmed(0);
        try {
          await postJson('/clear', { session: view.sessionId });
          view.entries = [];
          view.cursor = 0;
          view.stats = null;
          setStatus('cleared');
        } catch (error) {
          setStatus('failed');
        }
      };

      const wipeMemory = async function () {
        const next = memoryArmed + 1;
        if (next < MEMORY_CLEAR_CLICKS) {
          setMemoryArmed(next);
          return;
        }
        setMemoryArmed(0);
        try {
          await memoryManage({ op: 'clear', session: view.sessionId });
          setStatus('saved');
        } catch (error) {
          setStatus('failed');
        }
      };

      const grant = async function () {
        try {
          if (typeof Notification === 'undefined') return;
          await Notification.requestPermission();
          notify();
        } catch (error) {
          /* denied is fine */
        }
      };

      const granted = (function () {
        try {
          return typeof Notification !== 'undefined' && Notification.permission === 'granted';
        } catch (error) {
          return false;
        }
      })();

      return h('div', { className: 'ah-settings' }, [
        h('div', { className: 'ah-settings-row ah-settings-toggle', key: 'ai' },
          h('span', { className: 'ah-settings-label' },
            t('setting.ai'),
            h('span', { className: 'ah-settings-note' }, t('setting.aiNote')),
            h('span', { className: 'ah-settings-note' }, t('setting.aiNote2'))
          ),
          h('button', {
            type: 'button',
            className: 'ah-switch' + (config.aiEnabled === true ? ' ah-switch-on' : ''),
            role: 'switch',
            'aria-checked': config.aiEnabled === true ? 'true' : 'false',
            title: t('setting.ai'),
            onClick: async function () {
            if (localPinned === true && sid !== '') {
              await saveConfig(Object.assign({}, config, { aiEnabledLocal: Object.assign({}, aiLocalTable, { [sid]: aiLocalOn !== true }) }));
              return;
            }
            await flip('aiEnabled')();
          },
          }, h('span', { className: 'ah-switch-knob' }))
        ),
        h('div', { className: 'ah-settings-row', key: 'model' },
          h('span', { className: 'ah-settings-label' }, t('setting.model'), h('span', { className: 'ah-settings-note' }, t('setting.modelNote'))),
          modelField(t, modelDraft, commitModel)
        ),
        sid === '' ? null : row('model-local', t('config.modelLocal'), t('config.modelLocalNote'), localPinned, toggleLocal),

        h('div', { className: 'ah-section', key: 'sec-memory' }, t('setting.secMemory')),
        row('memory', t('setting.memory'), t('setting.memoryNote'), config.memoryEnabled === true, flip('memoryEnabled')),
        numRow('threshold', t('setting.threshold'), t('setting.thresholdNote'), config.threshold, function (value) { void savePatch({ threshold: value }); }, 1, 5),
        row('fpIgnoreJustification', t('setting.fpIgnoreJustification'), t('setting.fpIgnoreJustificationNote'), config.fpIgnoreJustification === true, flip('fpIgnoreJustification')),
        row('fileFingerprint', t('setting.fileFingerprint'), t('setting.fileFingerprintNote'), config.fileFingerprint === true, flip('fileFingerprint')),
        h('div', { className: 'ah-section', key: 'sec-card' }, t('setting.secCard')),
        row('autoExpandDescription', t('setting.autoExpand'), t('setting.autoExpandNote'), config.autoExpandDescription === true, flip('autoExpandDescription')),
        row('hideKnobs', t('setting.hideKnobs'), t('setting.hideKnobsNote'), config.hideKnobs !== false, flip('hideKnobs')),
        row('hint', t('setting.hint'), t('setting.hintNote'), config.composerHint === true, flip('composerHint')),
        row('pendingCard', t('setting.pendingCard'), t('setting.pendingNote'), config.pendingCard === true, flip('pendingCard')),
        row('aiAdviceCard', t('setting.aiAdviceCard'), t('setting.aiAdviceCardNote'), config.aiAdviceCard !== false, flip('aiAdviceCard')),
        row('dangerCard', t('setting.dangerCard'), t('setting.dangerCardNote'), config.dangerCard !== false, flip('dangerCard')),
        numRow('hintAi', t('setting.hintAi'), t('setting.hintAiNote'), hintMsValue('ai', 30000), function (value) { void patchHintMs('ai', value); }, 2000, 600000),
        numRow('hintMemory', t('setting.hintMemory'), t('setting.hintMemoryNote'), hintMsValue('memory', 8000), function (value) { void patchHintMs('memory', value); }, 2000, 600000),
        numRow('hintPending', t('setting.hintPending'), t('setting.hintPendingNote'), hintMsValue('pending', 0), function (value) { void patchHintMs('pending', value); }, 0, 600000),
        row('toast', t('setting.toast'), t('setting.toastNote'), config.toastEnabled === true, flip('toastEnabled')),
        h('div', { className: 'ah-section', key: 'sec-data' }, t('setting.secData')),

        h('div', { className: 'ah-settings-row', key: 'grant' },
          h('span', { className: 'ah-settings-label' }, granted ? t('setting.granted') : t('setting.grant')),
          granted ? null : h('button', { type: 'button', className: 'ah-btn', onClick: grant }, t('setting.grant'))
        ),
        h('div', { className: 'ah-settings-row', key: 'export' },
          h('span', { className: 'ah-settings-label' }, t('setting.export')),
          h('label', { className: 'ah-hint' },
            h('input', {
              type: 'checkbox',
              checked: exportScope === 'all',
              onChange: async function (event) {
                const next = event.target.checked ? 'all' : 'session';
                setExportScope(next);
                try {
                  await saveConfig(Object.assign({}, config, { exportScope: next }));
                } catch (error) {
                  /* the export route will refuse if this did not stick */
                }
              },
            }),
            ' ' + t('setting.exportAll')
          ),
          h('button', { type: 'button', className: 'ah-btn', onClick: function () { void download('csv', exportScope); } }, t('setting.csv')),
          h('button', { type: 'button', className: 'ah-btn', onClick: function () { void download('json', exportScope); } }, t('setting.json'))
        ),
        h('div', { className: 'ah-settings-row', key: 'danger-title', style: { borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 6 } },
          h('span', { className: 'ah-danger-title' }, t('setting.danger'))
        ),

        config.clearEnabled === true
          ? h('div', { className: 'ah-settings-row', key: 'clear' },
              h('span', { className: 'ah-settings-label' }, t('setting.clear')),
              h('button', { type: 'button', className: 'ah-btn ah-btn-danger', onClick: wipe },
                clearArmed === 0 ? t('setting.clear') : t('memory.confirm', { n: CLEAR_CLICKS - clearArmed }))
            )
          : null,
        h('div', { className: 'ah-settings-row', key: 'memory-clear' },
          h('span', { className: 'ah-settings-label' }, t('memory.clear')),
          h('button', { type: 'button', className: 'ah-btn ah-btn-danger', onClick: wipeMemory },
            memoryArmed === 0 ? t('memory.clear') : t('memory.confirm', { n: MEMORY_CLEAR_CLICKS - memoryArmed }))
        ),
        status === 'idle' ? null : h('div', { className: 'ah-hint', key: 'status' },
          status === 'saved' ? t('setting.saved') : (status === 'failed' ? t('setting.failed') : (status === 'cleared' ? t('setting.clearDone') : t('config.loading'))))
      ]);
    }

    // ─── 05 · 组件 · ApprovalPage：审批时间线 ─────────────────────
    /**
     * One approval row. Everything it needs arrives in `opts`, so it reads no
     * component state and can be rendered (and tested) on its own — the reason it lives
     * outside ApprovalPage instead of being an 85-line body inside its .map().
     */
    function approvalRowNode(entry, opts) {
        const chip = chipOf(entry, opts.t);
        const memory = memoryText(entry, opts.t);
        const laneTag = rowModelOf(entry);
        const stamp = stampOf(entry.ts);
        const reason = reasonBlockOf(entry);
        const reasonOpen = opts.isReasonOpen(entry.id);
        const mark = entry.outcome === 'rejected' ? '×' : (entry.outcome === 'allowed-once' ? '✓' : '·');
        return h('div', { className: 'ah-row', key: entry.id },
          // Left rail: the decision mark plus a connector, so a dense list still reads
          // as a timeline rather than a table.
          h('div', { className: 'ah-rail', key: 'rail' },
            h('span', { className: 'ah-rail-glyph ah-ink-' + chip.tone }, mark),
            h('span', { className: 'ah-rail-line' })
          ),
          h('div', { className: 'ah-body' },
            // The two text lines and the actions share one box: the buttons hang off
            // the *command*, so opening the description below does not move them.
            h('div', { className: 'ah-main', key: 'main' },
              h('div', { className: 'ah-line' },
                h('span', { className: 'ah-tool' }, String(entry.toolName || '—')),
                h('span', { className: 'ah-chip ah-tone-' + chip.tone }, chipBody(chip, memory, opts.t)),
                // Lane then date as ONE right-aligned group: "lane · 11-06 08:32:42".
                // Two separately right-aligned spans put a gap between them (the date
                // owns `margin-left:auto`), so the pair is wrapped instead.
                laneTag === null && stamp === '' ? null : h('span', { className: 'ah-row-stamp', key: 'stamp' },
                  // Structured degradation instead of one ellipsis: the multiplier goes
                  // first, then the provider, then the model's trailing qualifier. The
                  // full lane stays in the tooltip, so nothing is lost for good.
                  laneTag === null ? null : (function () {
                    const parts = laneParts(laneTag.text);
                    return h('span', { className: 'ah-lane', title: laneTag.title },
                      parts.provider === '' ? null : h('span', { className: 'ah-lane-provider' }, parts.provider),
                      h('span', { className: 'ah-lane-model' },
                        h('span', { className: 'ah-lane-model-long' }, parts.model),
                        h('span', { className: 'ah-lane-model-short' }, parts.short)),
                      parts.price === ' · ' ? null : h('span', { className: 'ah-lane-price' }, parts.price));
                  })(),
                  laneTag !== null && stamp !== '' ? h('span', { className: 'ah-row-sep', key: 'sep' }, ' · ') : null,
                  stamp === '' ? null : h('span', { className: 'ah-time-stamp' }, stamp))
              ),
              // Every line of the command is shown: an approval you cannot read is an
              // approval you are rubber-stamping.
              h('div', { className: 'ah-line' },
                h('span', { className: 'ah-args' }, commandOf(entry) === '' ? '—' : displayCommand(commandOf(entry))),
                deltaChip(rowDelta(entry), 'delta')
              ),
              // Description, then the change, then the one-click copy of the command.
              h('div', { className: 'ah-row-actions', key: 'actions' },
                entry.hasSnapshot === true
                  ? iconButton('pencil', opts.t('diff.change'), function () { void opts.openDiff(entry.callId); })
                  : null,
                reason.own === '' && reason.ai === ''
                  ? null
                  : iconButton(
                    reasonOpen ? 'chevronUp' : 'chevronDown',
                    reasonOpen ? opts.t('row.hideReason') : opts.t('row.showReason'),
                    function () { opts.toggleReason(entry.id); },
                  ),
                iconButton(
                  'copy',
                  opts.copiedId === entry.id ? opts.t('dock.copied') : opts.t('row.copy'),
                  function () { opts.copyRow(entry); },
                  opts.copiedId === entry.id ? 'ah-row-copy ah-icon-ok' : 'ah-row-copy',
                )
              )
            ),
            reasonOpen && (reason.own !== '' || reason.ai !== '')
              ? h('div', { className: 'ah-row-reason', key: 'reason' },
                reason.own === '' ? null : h('div', { className: 'ah-row-reason-own', key: 'own' }, reason.own),
                reason.ai === ''
                  ? null
                  : h('div', { className: 'ah-row-reason-ai' + (reason.own === '' ? ' ah-row-reason-ai-solo' : ''), key: 'ai' },
                    h('div', { className: 'ah-row-reason-head', key: 'head' },
                      h('span', { className: 'ah-row-reason-label', key: 'label' }, opts.t(reason.label)),
                      reason.risk === ''
                        ? null
                        : h('span', { className: 'ah-risk ah-risk-' + reason.risk, key: 'risk' }, opts.t('row.risk') + ' · ' + riskLabel(reason.risk, opts.t))),
                    h('div', { className: 'ah-row-reason-text', key: 'text' }, reason.ai)))
              : null,
            opts.view.diff !== null && opts.view.diff.callId === entry.callId && opts.view.diff.inline === true ? renderDiff(opts.t, opts.view) : null,
          ),
        );
    }

    function ApprovalPage(props) {
      const t = translator(props);
      const view = useStore();
      const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : '';

      const rootRef = React.useRef(null);
      // "Is this list really on screen?" — the dock uses it to stop drawing a card for a
      // request the human is already looking at. A tab that stays mounted while hidden
      // would answer "yes" wrongly, so this observes visibility instead of mount state.
      React.useEffect(function () {
        const host = rootRef.current;
        if (host === null || typeof IntersectionObserver === 'undefined') {
          store.pageVisible = true;
          return function () { store.pageVisible = false; };
        }
        const observer = new IntersectionObserver(function (entries) {
          const visible = entries.length > 0 && entries[0].isIntersecting === true;
          if (store.pageVisible === visible) return;
          store.pageVisible = visible;
          notify();
        }, { threshold: 0 });
        observer.observe(host);
        return function () {
          observer.disconnect();
          store.pageVisible = false;
        };
      }, []);

      const copyState = React.useState('');
      const copiedId = copyState[0];
      const setCopiedId = copyState[1];

      // Which rows have their description open. Stream frames re-render the page, so
      // this has to be component state rather than a closure variable.
      const openState = React.useState({});
      const openRows = openState[0];
      const setOpenRows = openState[1];
      // "Expand automatically" makes open the default, so a click has to store an
      // explicit false — deleting the key would re-open it on the next render.
      const autoExpand = view.config !== null && view.config.autoExpandDescription === true;
      const isReasonOpen = function (id) {
        return openRows[id] === true || (autoExpand === true && openRows[id] !== false);
      };
      const toggleReason = function (id) {
        const next = Object.assign({}, openRows);
        next[id] = isReasonOpen(id) !== true;
        setOpenRows(next);
      };

      React.useEffect(function () {
        if (copiedId === '') return undefined;
        const timer = setTimeout(function () { setCopiedId(''); }, 1500);
        return function () { clearTimeout(timer); };
      }, [copiedId]);

      /** The command (or the path) that was approved — what people actually paste. */
      const copyRow = function (entry) {
        // `argsSummary` is capped by the ledger (that is why copy stopped mid-command);
        // `commandOf` reads the stored arguments instead.
        const text = commandOf(entry) || reasonOf(entry) || String(entry.argsSummary || '');
        void copyToClipboard(text).then(function (ok) { if (ok === true) setCopiedId(entry.id); });
      };

      React.useEffect(function () {
        // Opening the tab consumes the badge; the watermark we consumed is kept so
        // the list can draw "new since last visit" above it.
        const session = sessionId === '' ? store.sessionId : sessionId;
        if (store.seenTimer !== null) {
          clearTimeout(store.seenTimer);
          store.seenTimer = null;
        }
        if (store.pageSid !== session) {
          store.pageSid = session;
          store.pageSeenAt = store.seenAt;
        }
        store.unread = 0;
        pushTabLabel();
        notify();
        return function () {
          // Coming back within 8s is still the same visit: commit the watermark on a
          // timer, so flicking between tabs does not erase the divider.
          store.pageSid = '';
          if (store.seenTimer !== null) clearTimeout(store.seenTimer);
          store.seenTimer = setTimeout(function () {
            store.seenTimer = null;
            let max = store.seenAt;
            for (const row of store.entries) max = Math.max(max, Number(row.ts) || 0);
            store.seenAt = max;
            if (session !== '') storageSet('review-hub:seen:' + session, max);
            store.pageSeenAt = 0;
            pushTabLabel();
            notify();
          }, 8000);
        };
      }, [sessionId]);

      React.useEffect(function () {
        if (view.showMemory === true) loadMemory(true);
      }, [view.showMemory]);

      // The toolbar prints "memory N" before the panel is ever opened, so the count
      // has to load with the session rather than with the expansion.
      React.useEffect(function () {
        if (sessionId === '') return;
        void loadMemory(true, sessionId);
      }, [sessionId]);

      React.useEffect(function () {
        // `next` comes from the server; without it the bar simply prints nothing.
        void loadModels(false);
      }, [sessionId]);

      const stats = isPlainObject(view.stats) ? view.stats : {};
      const catalog = isPlainObject(view.models) ? view.models : {};
      const nextLane = isPlainObject(catalog.next) && typeof catalog.next.provider === 'string' && catalog.next.provider !== ''
        && typeof catalog.next.model === 'string' && catalog.next.model !== ''
        ? catalog.next.provider + '/' + catalog.next.model
        : '';
      // One chunk per number: the bar drops whole groups as it narrows, never half of one.
      const barChunks = [
        t('bar.total', { n: Number(stats.total) || 0 }),
        t('bar.allow', { n: Number(stats.allow) || 0 }),
        t('bar.deny', { n: Number(stats.deny) || 0 }),
        t('bar.cancelled', { n: Number(stats.cancelled) || 0 }),
        t('bar.unavailable', { n: Number(stats.unavailable) || 0 }),
        nextLane === '' ? '' : t('model.next', { lane: laneLabel(nextLane) }),
      ];
      const strip = t('bar.strip', {
        total: Number(stats.total) || 0,
        allow: Number(stats.allow) || 0,
        deny: Number(stats.deny) || 0,
        cancelled: Number(stats.cancelled) || 0,
        unavailable: Number(stats.unavailable) || 0,
      });

      const needle = view.query.trim().toLowerCase();
      const fromAt = view.fromTime === '' ? 0 : new Date(view.fromTime).getTime();
      const toAt = view.toTime === '' ? 0 : new Date(view.toTime).getTime();
      // The tool list covers the session on screen only: offering another session's
      // tools is offering filters that empty the list.
      const sessionRows = view.entries.filter(function (entry) {
        return sessionId === '' || typeof entry.sessionId !== 'string' || entry.sessionId === '' || entry.sessionId === sessionId;
      });
      const toolNames = [];
      for (const entry of sessionRows) {
        const name = String(entry.toolName || '—');
        if (toolNames.indexOf(name) < 0) toolNames.push(name);
      }
      toolNames.sort();
      const picked = typeof view.tool === 'string' && toolNames.indexOf(view.tool) >= 0 ? view.tool : '';
      const filtering = needle !== '' || picked !== ''
        || (Number.isFinite(fromAt) && fromAt > 0) || (Number.isFinite(toAt) && toAt > 0);
      const visible = sessionRows.filter(function (entry) {
        const ts = Number(entry.ts) || 0;
        if (picked !== '' && String(entry.toolName || '—') !== picked) return false;
        if (fromAt > 0 && ts < fromAt) return false;
        if (toAt > 0 && ts > toAt) return false;
        if (needle === '') return true;
        const chip = chipOf(entry, t);
        const haystack = [entry.toolName, chip.text, commandOf(entry), reasonOf(entry), entry.riskRule].join(' ').toLowerCase();
        return haystack.indexOf(needle) >= 0;
      });

      // A decision that has not happened yet is still a row the page should show: the
      // record only exists after it lands, and waiting for that felt like a stale UI.
      const waitingRows = view.pending
        .filter(function (row) { return row.debug !== true; })
        .filter(function (row) { return sessionId === '' || row.sessionId === sessionId; })
        .map(function (row) {
          const advice = typeof row.aiReason === 'string' && row.aiReason !== '' ? row.aiReason : '';
          return h('div', { className: 'ah-row ah-row-waiting', key: 'w-' + row.id },
            h('div', { className: 'ah-rail', key: 'rail' },
              h('span', { className: 'ah-rail-glyph ah-ink-warn' }, '⋯'),
              h('span', { className: 'ah-rail-line' })
            ),
            h('div', { className: 'ah-body' },
              h('div', { className: 'ah-line' },
                h('span', { className: 'ah-tool' }, String(row.toolName || '—')),
                h('span', { className: 'ah-chip ah-tone-warn' }, t('row.waiting')),
                h('span', { className: 'ah-time-stamp' }, stampOf(row.startedAt))
              ),
              h('div', { className: 'ah-line' },
                h('span', { className: 'ah-args', title: advice }, String(row.argsSummary || row.reason || '') + (advice === '' ? '' : '   ·   AI：' + advice))
              )
            )
          );
        });

      // One bag for the row renderer: its callbacks stay in the component, the row body
      // stays testable without a component tree.
      const rowOpts = {
        t: t,
        view: view,
        copiedId: copiedId,
        isReasonOpen: isReasonOpen,
        openDiff: openDiff,
        copyRow: copyRow,
        toggleReason: toggleReason,
      };
      const rows = visible.map(function (entry) { return approvalRowNode(entry, rowOpts); });



      return h('div', { className: 'ah-view', ref: rootRef }, [
        h('div', { className: 'ah-bar', key: 'bar' },
          h(BarText, { key: 'text', chunks: barChunks }),
          h('span', { className: 'ah-bar-spacer' }),
          view.online === false ? h('span', { className: 'ah-tone-danger' }, 'offline') : null,
          h('button', {
            type: 'button',
            className: 'ah-btn',
            title: t('bar.memoryOpen'),
            onClick: function () { openMemory(); },
          }, t('bar.memory', { n: memoryRows().length })),
          h('button', {
            type: 'button',
            className: 'ah-icon-btn' + (view.filterOpen === true ? ' ah-icon-on' : '')
              // Collapsed while a filter is still on: what is on screen is not everything.
              + (view.filterOpen !== true && filtering === true ? ' ah-icon-filtered' : ''),
            title: view.filterOpen !== true && filtering === true ? t('bar.searchFiltered') : t('bar.search'),
            'aria-label': t('bar.search'),
            onClick: function () { view.filterOpen = view.filterOpen !== true; notify(); },
          }, icon('search', 16)),
          h('button', {
            type: 'button',
            className: 'ah-icon-btn',
            title: t('bar.stats'),
            'aria-label': t('bar.stats'),
            onClick: function () { openStats(); },
          }, icon('stats', 16)),
          h('button', {
            type: 'button',
            className: 'ah-icon-btn' + (view.settingsOpen === true ? ' ah-icon-on' : ''),
            title: t('bar.settings'),
            'aria-label': t('bar.settings'),
            onClick: function () { openSettings(); },
          }, icon('gear', 16))
        ),
        // Two rows, always: squeezing five controls into one line is what made the
        // text collide once the sidebar halved the pane.
        h('div', { className: 'ah-filter', key: 'filter', hidden: view.filterOpen !== true }, [
          h('div', { className: 'ah-filter-row', key: 'row1' },
            h('select', {
              className: 'ah-input ah-filter-tool',
              key: 'tool',
              value: picked,
              title: t('filter.tool'),
              onChange: function (event) { view.tool = event.target.value; notify(); },
            }, [h('option', { key: 'all', value: '' }, t('filter.tool'))].concat(toolNames.map(function (name) {
              return h('option', { key: 'tool-' + name, value: name }, name);
            }))),
            h('input', {
              className: 'ah-input',
              type: 'search',
              placeholder: t('filter.text'),
              value: view.query,
              onChange: function (event) { view.query = event.target.value; notify(); },
            }),
            // Long form when there is room, bare "N 条" once the pane narrows (sidebar open).
            h('span', { className: 'ah-filter-count' },
              h('span', { className: 'ah-filter-count-long', key: 'long' }, filtering === true
                ? t('filter.count', { n: visible.length })
                : t('filter.countNone')),
              h('span', { className: 'ah-filter-count-short', key: 'short' }, filtering === true
                ? t('filter.countShort', { n: visible.length })
                : '-')),
            h('button', {
              type: 'button',
              className: 'ah-btn',
              onClick: function () { view.query = ''; view.tool = ''; view.fromTime = ''; view.toTime = ''; notify(); },
            }, t('filter.clear'))),
          h('div', { className: 'ah-filter-row', key: 'row2' },
            h('input', {
              className: 'ah-time',
              type: 'datetime-local',
              title: t('filter.from'),
              value: view.fromTime,
              onChange: function (event) { view.fromTime = event.target.value; notify(); },
            }),
            h('input', {
              className: 'ah-time',
              type: 'datetime-local',
              title: t('filter.to'),
              value: view.toTime,
              onChange: function (event) { view.toTime = event.target.value; notify(); },
            })),
        ]),
        view.settingsOpen === true ? h(SettingsPanel, { key: 'settings', locale: props && props.locale }) : null,
        view.showMemory === true && sideAvailable !== true
          ? h('div', { className: 'ah-memory', key: 'memory' }, h(MemoryBody, { locale: props && props.locale }))
          : null,
        h('div', { className: 'ah-list', key: 'list' },
          rows.length === 0
            ? h('div', { className: 'ah-empty' }, filtering ? t('empty.filter') : t('empty.session'))
            : waitingRows.concat(withDivider(rows, visible, view.pageSeenAt, t))
        ),
      ]);
    }

    const AGENT_KINDS = ['default', 'subagent', 'scheduled', 'task_board', 'unknown'];

    const PREVIEW_KINDS = ['ai', 'memory', 'pending', 'reviewing', 'timeout', 'danger', 'other'];
    const PREVIEW_LABELS = {
      ai: 'chip.ai',
      memory: 'chip.memory',
      pending: 'preview.kindPending',
      reviewing: 'preview.kindReviewing',
      timeout: 'preview.kindTimeout',
      danger: 'preview.kindDanger',
      other: 'dock.otherChip',
    };
    // Which switch owns each sample, so the preview answers "why did I not see this".
    const PREVIEW_OWNERS = {
      ai: 'setting.aiAdviceCard',
      memory: 'setting.memory',
      pending: 'setting.pendingCard',
      reviewing: 'setting.pendingCard',
      timeout: 'setting.dangerCard',
      danger: 'setting.dangerCard',
      other: 'setting.hint',
    };

    /** The five sample cards, written as data now that the popup window is gone. */
    function previewSamples(t) {
      return {
        ai: { kind: 'ai', chip: t('chip.ai'), main: 'pwsh · Get-ChildItem -Name C:/Users/x', sub: '11-06 10:22:01 · 2958ms', ringMs: 30000, ringSpentMs: 6000 },
        memory: {
          kind: 'memory',
          chip: t('chip.memory'),
          main: 'pwsh · echo probe',
          sub: '11-06 10:23:11 · 0ms',
          ringMs: 8000,
          ringSpentMs: 2000,
        },
        // Nothing decided yet: this is the card you see while the request is still open.
        pending: {
          kind: 'pending',
          chip: '',
          main: 'edit · C:/Users/x/cordis.patch.yml',
          sub: t('dock.pendingLine', { time: '11-06 10:24:02' }),
        },
        // Still being reviewed: the only card on screen while the reviewer is thinking.
        reviewing: {
          kind: 'pending',
          chip: '',
          main: 'pwsh · Remove-Item -Recurse -Force D:/tmp',
          sub: t('dock.pendingReviewing', { sec: 7, spin: '│' }),
          spin: true,
        },
        // Reviewed, but no verdict came back: red edge, no spinner, no pretending.
        timeout: { kind: 'pending', danger: true, chip: t('row.highRisk'), main: 'pwsh · New-Item C:/Users/x/probe.txt', sub: t('dock.pendingFailed') },
        danger: { kind: 'pending', danger: true, chip: t('row.highRisk'), main: 'pwsh · Remove-Item -Recurse -Force D:/tmp', sub: '未进 AI 审查：命中 L0 删除类' },
        other: { kind: 'other', chip: t('dock.otherChip'), main: '审批中心 (1)', sub: '等待审批 1 · AI通过 0 · 记忆通过 1' },
      };
    }

    /** A live row's card tone follows the same decision chip the dock prints. */
    function previewLook(tone) {
      if (tone === 'learn') return { kind: 'memory', danger: false };
      if (tone === 'ok') return { kind: 'ai', danger: false };
      return { kind: 'pending', danger: tone === 'danger' };
    }

    /**
     * Card preview inside the settings card: one sample per kind plus this session's
     * own rows, rendered by the same cardNode the dock uses — a tone or a chip can be
     * checked without opening a second window.
     */
    function CardPreview(props) {
      const t = translator(props);
      const view = useStore();
      const state = React.useState(PREVIEW_KINDS[0]);
      const kind = state[0];
      const setKind = state[1];
      const samples = previewSamples(t);
      const sample = samples[kind] === undefined ? samples.ai : samples[kind];
      const buttons = PREVIEW_KINDS.map(function (id) {
        return h('button', {
          type: 'button',
          key: id,
          className: id === kind ? 'ah-btn ah-btn-active' : 'ah-btn',
          onClick: function () { setKind(id); },
        }, t(PREVIEW_LABELS[id]) === undefined ? t('preview.kindPending') : t(PREVIEW_LABELS[id]),
        // Name the switch that owns this sample: "I never see this card" is almost always
        // a switch that is off, and the preview is where that gets answered.
        h('span', { key: 'owner', className: 'ah-hint' }, t('preview.owner', { name: t(PREVIEW_OWNERS[id] || 'setting.pendingCard') })));
      });
      // A way to see the floating advice card without waiting for a real approval: the
      // card is driven by store.pending, so we put one row in and sync by hand (the dock
      // may not even be mounted on the plugin page). The row is marked so the approval
      // list — which reads the same array — never shows it.
      const cardRef = React.useRef(null);
      /** The settings card is laid out on the same content column as the chat: measure it. */
      const cardAnchor = function () {
        const node = cardRef.current;
        if (node === null || typeof node.getBoundingClientRect !== 'function') return null;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0) return null;
        let column = 0;
        try {
          column = parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue('--dsh-chat-content-width')) || 0;
        } catch (error) {
          column = 0;
        }
        const width = Math.max(240, Math.min(rect.width - 32, column > 0 ? column + 32 : rect.width - 32));
        return { left: rect.left + (rect.width - width) / 2, width: width, top: Math.max(8, rect.top + 8) };
      };
      const floatState = React.useState('');
      const floatMsg = floatState[0];
      const setFloatMsg = floatState[1];
      const tryFloat = function (danger) {
        const config = view.config === null ? {} : view.config;
        if (config.composerHint === false || config.pendingCard !== true) {
          setFloatMsg(t('preview.floatBlocked'));
          return;
        }
        if (store.pageVisible === true) {
          setFloatMsg(t('preview.floatHidden'));
          return;
        }
        const id = 'preview-float-' + String(Date.now());
        const base = {
          id: id,
          sessionId: store.sessionId,
          toolName: 'ops_bash',
          argsSummary: 'bash -lc "npm run build --dry-run"',
          reason: t('preview.floatReason'),
          aiReviewed: true,
          startedAt: Date.now(),
          debug: true,
        };
        // Two shapes, because they carry different text: an AI suggestion and an L0
        // hard-risk row that never reached the reviewer at all.
        const row = danger === true
          ? Object.assign({}, base, { argsSummary: 'bash -lc "rm -rf D:/tmp/build"', aiReason: '', aiRisk: 'high', riskLevel: 'high', riskRule: 'delete' })
          : Object.assign({}, base, { aiReason: t('preview.floatAdvice'), aiRisk: 'high' });
        store.pending = [row].concat(Array.isArray(store.pending) ? store.pending : []);
        notify();
        syncAdviceOverlay(t, cardAnchor());
        setFloatMsg(adviceOverlay.anchor === null ? t('preview.floatNoAnchor') : t('preview.floatShown'));
        setTimeout(function () {
          store.pending = (store.pending || []).filter(function (item) { return item.id !== id; });
          notify();
          syncAdviceOverlay(t);
          setFloatMsg('');
        }, 12000);
      };
      const entries = (Array.isArray(view.entries) ? view.entries : []).slice(-6);
      const pending = Array.isArray(view.pending) ? view.pending : [];
      const liveCards = entries.map(function (entry) {
        const chip = chipOf(entry, t);
        const look = previewLook(chip.tone);
        return cardNode({
          key: 'live-' + String(entry.id),
          kind: look.kind,
          danger: look.danger,
          chip: chip.text,
          main: String(entry.toolName || '') + ' · ' + String(entry.argsSummary || reasonOf(entry) || '').slice(0, 160),
          sub: stampOf(entry.ts),
        });
      });
      const pendingCards = pending.map(function (row) {
        const high = row.riskLevel === 'high';
        const reason = typeof row.aiReason === 'string' && row.aiReason !== '' ? row.aiReason : '';
        return cardNode({
          key: 'preview-' + String(row.id),
          kind: 'pending',
          danger: high,
          chip: high ? t('row.highRisk') : t('chip.human'),
          main: String(row.toolName || '') + ' · ' + String(row.argsSummary || row.reason || '').slice(0, 160),
          sub: reason !== '' ? reason : t('dock.pendingLine', { time: stampOf(row.startedAt) }),
        });
      });
      return h('div', { className: 'ah-preview', ref: cardRef }, [
        h('div', { className: 'ah-preview-btns', key: 'btns' }, buttons),
        cardNode({
          key: 'sample',
          kind: sample.kind,
          danger: sample.danger === true,
          chip: sample.chip,
          main: sample.main,
          sub: sample.sub,
          ringMs: sample.ringMs,
          ringSpentMs: sample.ringSpentMs,
        }),
        h('div', { className: 'ah-hint', key: 'sample-hint' }, t('preview.sampleHint')),
        h('div', { className: 'ah-hint', key: 'recent-title' }, t('preview.recent')),
        liveCards.length === 0
          ? h('div', { className: 'ah-hint', key: 'recent-empty' }, t('empty.session'))
          : liveCards,
        h('div', { className: 'ah-preview-btns', key: 'float-btns' },
          h('button', { type: 'button', className: 'ah-btn', onClick: function () { tryFloat(false); } }, t('preview.floatTry')),
          h('button', { type: 'button', className: 'ah-btn', onClick: function () { tryFloat(true); } }, t('preview.floatTryDanger'))),
        floatMsg === '' ? null : h('div', { className: 'ah-hint', key: 'float-msg' }, floatMsg),
        h('div', { className: 'ah-hint', key: 'float-hint' }, t('preview.floatHint')),
        h('div', { className: 'ah-hint', key: 'pending-title' }, t('preview.pending')),
        pendingCards.length === 0
          ? h('div', { className: 'ah-hint', key: 'pending-empty' }, t('preview.noPending'))
          : pendingCards,
      ]);
    }

    // ─── 05 · 组件 · ConfigCard：插件页「高级设置」卡 ────────────
    function ConfigCard(props) {
      const t = translator(props);
      const view = useStore();
      // `debugDraft` only exists so the smoke test can render the real card without a
      // host: a reference to an identifier that lives in a sibling component throws here
      // and used to blank the whole plugin page with no test failing.
      const state = React.useState(props !== null && props !== undefined && props.debugDraft !== undefined ? props.debugDraft : null);
      const draft = state[0];
      const setDraft = state[1];
      const statusState = React.useState('idle');
      const status = statusState[0];
      const setStatus = statusState[1];

      React.useEffect(function () {
        let alive = true;
        api('/config').then(function (body) {
          if (alive === false || isPlainObject(body) === false) return;
          setDraft(body);
        }).catch(function () {
          if (alive === true) setStatus('failed');
        });
        return function () { alive = false; };
      }, []);

      // A switch that only edits the draft *looks* saved and is not: the forensic and
      // safety toggles are diagnostics, so they persist on the spot like the everyday ones.
      const toggleNow = function (field, next) {
        const merged = Object.assign({}, draft || {}, { [field]: next });
        change(field, next);
        void saveConfig(merged);
      };
      const change = function (field, value) {
        setDraft(function (current) { return Object.assign({}, current || {}, { [field]: value }); });
      };

      const save = async function () {
        setStatus('saving');
        try {
          // Saving also records which language the panel is showing, so "follow the UI"
        // resolves to something real instead of guessing from the request text.
        const body = await saveConfig(Object.assign({}, draft || {}, { panelLocale: String(props?.locale ?? '') }));
          setDraft(body);
          setStatus('saved');
        } catch (error) {
          setStatus('failed');
        }
      };

      if (draft === null) return h('div', { className: 'ah-hint' }, t('config.loading'));

      /** A comma/newline separated tool list; commits on blur like every other field. */
      const toolListField = function (field, label, hint) {
        return h('div', { className: 'ah-settings-row ah-settings-stack', key: field },
          h('span', { className: 'ah-settings-label' },
            label,
            h('span', { className: 'ah-settings-note' }, hint)
          ),
          h('textarea', {
            className: 'ah-input ah-textarea',
            spellCheck: false,
            rows: 3,
            defaultValue: Array.isArray(draft[field]) ? draft[field].join(', ') : '',
            onBlur: function (event) {
              change(field, String(event.target.value || '').split(/[,\s]+/).filter(function (name) { return name !== ''; }));
            },
          })
        );
      };

      const numberField = function (field, label, hint) {
        return h('label', { className: 'ah-settings-row', key: field },
          h('span', { className: 'ah-settings-label' },
            label,
            hint === undefined || hint === '' ? null : h('span', { className: 'ah-settings-note' }, hint)
          ),
          h('input', {
            className: 'ah-input',
            type: 'number',
            value: draft[field] === undefined ? '' : draft[field],
            onChange: function (event) { change(field, event.target.value); },
            style: { maxWidth: 120 },
          })
        );
      };

      // Everyday settings live in the approval tab. This card keeps the knobs that
      // change failure behaviour or performance — nothing here should be touched
      // without a reason, so it says so before the controls.
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 } }, [

        // The page header already names the plugin; this card is where the line
        // that explains *why* it exists belongs, so it gets the room and the centre.
        h('div', { className: 'ah-motto', key: 'motto' }, t('config.motto')),
        h('div', { className: 'ah-section', key: 'sec-adv' }, t('config.secAdvanced')),
        h('div', { className: 'ah-settings-row', key: 'adv-warn' },
          h('span', { className: 'ah-hint ah-tone-warn' }, t('config.advancedWarn'))
        ),
        numberField('pollMs', t('config.pollMs')),
        numberField('maxEntriesPerSession', t('config.maxEntries')),
        numberField('humanFirstMs', t('config.humanFirst'), t('config.humanFirstNote')),
        numberField('reviewTimeoutMs', t('config.timeout')),
        numberField('aiCacheTtlMs', t('config.cacheTtl'), t('config.cacheTtlNote')),
        numberField('aiReasonChars', t('config.reasonChars'), t('config.reasonCharsNote')),
        h('label', { className: 'ah-settings-row', key: 'prompt-append' },
          h('span', { className: 'ah-settings-label' }, t('config.promptAppend'), h('span', { className: 'ah-settings-note' }, t('config.promptAppendNote'))),
          h('textarea', {
            className: 'ah-input',
            value: draft.promptAppend === undefined ? '' : draft.promptAppend,
            rows: 3,
            onChange: function (event) { change('promptAppend', event.target.value); },
          })
        ),
        h('label', { className: 'ah-settings-row', key: 'reviewer-locale' },
          h('span', { className: 'ah-settings-label' }, t('config.reviewerLocale'), h('span', { className: 'ah-settings-note' }, t('config.reviewerLocaleNote'))),
          h('select', {
            className: 'ah-input',
            value: draft.reviewerLocale === undefined ? '' : draft.reviewerLocale,
            onChange: function (event) { change('reviewerLocale', event.target.value); },
          }, [
            h('option', { key: 'auto', value: '' }, t('config.localeAuto')),
            h('option', { key: 'zh', value: 'zh' }, '中文（简体）'),
            h('option', { key: 'zh-Hant', value: 'zh-Hant' }, '中文（繁體）'),
            h('option', { key: 'en', value: 'en' }, 'English'),
            h('option', { key: 'ja', value: 'ja' }, '日本語'),
            h('option', { key: 'ko', value: 'ko' }, '한국어'),
            h('option', { key: 'de', value: 'de' }, 'Deutsch'),
            h('option', { key: 'fr', value: 'fr' }, 'Français'),
            h('option', { key: 'es', value: 'es' }, 'Español'),
            h('option', { key: 'ru', value: 'ru' }, 'Русский'),
            h('option', { key: 'pt', value: 'pt' }, 'Português'),
          ])
        ),
        numberField('aiBudgetPerTurn', t('config.budget')),
        numberField('aiBreakerFails', t('config.breaker')),
        // The deltas on the built-in AI baseline. A textarea, not an input: a dozen tool
        // names in a single line is a list nobody can read or check.
        toolListField('aiTools', t('config.aiTools'), t('config.aiToolsNote')),
        toolListField('aiToolsDeny', t('config.aiToolsDeny'), t('config.aiToolsDenyNote')),
        h('div', { className: 'ah-settings-row', key: 'agent-title' },
          h('span', { className: 'ah-settings-label' }, t('config.agent'), h('span', { className: 'ah-settings-note' }, t('config.agentNote')))
        ),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } }, AGENT_KINDS.map(function (kind) {
          const current = (draft.agentPolicy || {})[kind] || 'strict';
          return h('label', { key: kind, className: 'ah-settings-row', style: { gap: 4 } },
            h('span', { className: 'ah-hint' }, kind),
            h('select', {
              className: 'ah-btn',
              value: current,
              onChange: function (event) {
                change('agentPolicy', Object.assign({}, draft.agentPolicy || {}, { [kind]: event.target.value }));
              },
            }, ['full', 'strict', 'off'].map(function (level) { return h('option', { key: level, value: level }, level); }))
          );
        })),
        numberField('snapshotRetentionDays', t('config.snapshotDays'), t('config.snapshotDaysNote')),
        h('div', { className: 'ah-settings-row', key: 'debug-headers' },
          h('span', { className: 'ah-settings-label' }, t('config.debugHeaders'), h('span', { className: 'ah-settings-note' }, t('config.debugHeadersNote'))),
          h('button', {
            type: 'button',
            className: 'ah-switch' + (draft.debugHeaders === true ? ' ah-switch-on' : ''),
            role: 'switch',
            'aria-checked': draft.debugHeaders === true ? 'true' : 'false',
            title: t('config.debugHeaders'),
            onClick: function () { toggleNow('debugHeaders', draft.debugHeaders !== true); },
          }, h('span', { className: 'ah-switch-knob' }))
        ),
        h('div', { className: 'ah-settings-row', key: 'debug-review' },
          h('span', { className: 'ah-settings-label' }, t('config.debugReview'), h('span', { className: 'ah-settings-note' }, t('config.debugReviewNote'))),
          h('button', {
            type: 'button',
            className: 'ah-switch' + (draft.debugReview === true ? ' ah-switch-on' : ''),
            role: 'switch',
            'aria-checked': draft.debugReview === true ? 'true' : 'false',
            title: t('config.debugReview'),
            onClick: function () { toggleNow('debugReview', draft.debugReview !== true); },
          }, h('span', { className: 'ah-switch-knob' }))
        ),
        h('div', { className: 'ah-settings-row', key: 'clear-on' },
          h('span', { className: 'ah-settings-label' }, t('config.clearOn'), h('span', { className: 'ah-settings-note' }, t('config.clearOnNote'))),
          h('button', {
            type: 'button',
            className: 'ah-switch' + (draft.clearEnabled === true ? ' ah-switch-on' : ''),
            role: 'switch',
            'aria-checked': draft.clearEnabled === true ? 'true' : 'false',
            title: t('config.clearOn'),
            onClick: function () { change('clearEnabled', draft.clearEnabled !== true); },
          }, h('span', { className: 'ah-switch-knob' }))
        ),
        h('div', { className: 'ah-settings-row', key: 'strict-verdict' },
          h('span', { className: 'ah-settings-label' }, t('config.strictVerdict'), h('span', { className: 'ah-settings-note' }, t('config.strictVerdictNote'))),
          h('button', {
            type: 'button',
            className: 'ah-switch' + (draft.strictVerdict === true ? ' ah-switch-on' : ''),
            role: 'switch',
            'aria-checked': draft.strictVerdict === true ? 'true' : 'false',
            title: t('config.strictVerdict'),
            onClick: function () { toggleNow('strictVerdict', draft.strictVerdict !== true); },
          }, h('span', { className: 'ah-switch-knob' }))
        ),
        // Always on, and last: the preview is a looking glass, not a setting — it belongs
        // under everything you actually came here to change.
        h(CardPreview, { key: 'card-preview', locale: props === null || props === undefined ? undefined : props.locale }),
        h('div', { className: 'ah-settings-row', key: 'actions' },
          h('button', { type: 'button', className: 'ah-btn', onClick: save, disabled: status === 'saving' }, t('config.save')),
          status === 'saved' ? h('span', { className: 'ah-hint' }, t('config.saved')) : null,
          status === 'failed' ? h('span', { className: 'ah-hint ah-tone-danger' }, t('config.failed')) : null
        ),
      ]);
    }

    /**
     * The reviewer's advice, rendered inside the host's own approval panel via its
     * child seat `conversation.approval.detail` — the panel is where the human is
     * looking, so nothing has to be floated on top of it.
     */
    function AdviceBand(props) {
      const t = translator(props);
      const view = useStore();
      const rows = (view.pending || []).filter(function (row) {
        return view.sessionId === '' || row.sessionId === view.sessionId;
      });
      if (rows.length === 0) return null;
      const row = rows[0];
      const dangerous = row.riskLevel === 'high';
      const reason = typeof row.aiReason === 'string' && row.aiReason !== '' ? row.aiReason : '';
      const line = reason !== ''
        ? t('band.advice', { risk: String(row.aiRisk || row.riskLevel || 'unknown'), reason: reason })
        : (dangerous ? t('band.hardRisk', { rule: String(row.riskRule || '') }) : t('band.noAdvice'));
      return h('div', { className: 'ah-band' + (dangerous ? ' ah-band-danger' : '') },
        h('span', { className: 'ah-band-chip' }, dangerous ? t('row.highRisk') : t('chip.human')),
        h('span', { className: 'ah-band-text', title: line }, line)
      );
    }

    /** The learned operations of this session, as its own surface (tab or inline). */
    /** The newest recorded entry for one call id, if this page already has it. */
    function entryByCallId(callId) {
      if (typeof callId !== 'string' || callId === '') return undefined;
      for (const entry of store.entries) if (entry.callId === callId) return entry;
      return undefined;
    }

    /**
     * The "+N −N" for a memory row. One approval, one number: a memory row that has
     * already merged several approvals has no single diff, so it shows none. The real
     * stored diff wins over the parameter estimate.
     */
    function memoryDelta(row) {
      if ((Number(row !== null && row !== undefined ? row.count : 0) || 0) !== 1) return null;
      const calls = row !== null && row !== undefined && Array.isArray(row.calls) ? row.calls : [];
      const entry = entryByCallId(calls[0]);
      const recorded = entry === undefined ? undefined : entry.fileDelta;
      if (isPlainObject(recorded) === true) return { add: Number(recorded.add) || 0, del: Number(recorded.del) || 0 };
      return memoryEstimate(row);
    }

    /** The parameter estimate kept with the fingerprint material (fallback only). */
    function memoryEstimate(row) {
      const material = row !== null && row !== undefined && typeof row.material === 'string' ? row.material : '';
      const cut = material.indexOf('\u0000');
      if (cut < 0) return null;
      const raw = material.slice(cut + 1).trim();
      if (raw.charAt(0) !== '{') return null;
      try {
        return deltaOf(JSON.parse(raw));
      } catch {
        return null;
      }
    }

    /**
     * A string that can only be an absolute path — Windows drive, UNC, POSIX. The
     * ledger keeps shrunk paths ("…/desktop/x.yml") and arguments are full of JSON and
     * URLs, so "contains a slash" was never enough to call something a file.
     *
     * Separators are compared by code point: a regex for two backslashes is a line
     * nobody can read or review, and this is a security-adjacent decision.
     */
    const BACKSLASH = 92;
    const DRIVE_LETTER = /^[A-Za-z]:$/;

    function pathLike(value) {
      const text = typeof value === 'string' ? value.trim() : '';
      if (text === '' || text.length > 400) return '';
      // The shrink marker means the real directory is gone: such a path can never key
      // a file count or a switch, so it must not be shown as if it could.
      if (text.indexOf('\u2026') >= 0) return '';
      const first = text.charCodeAt(0);
      if (first === 47) return text;
      if (first === BACKSLASH && text.charCodeAt(1) === BACKSLASH) return text;
      if (DRIVE_LETTER.test(text.slice(0, 2)) === true) {
        const sep = text.charCodeAt(2);
        if (sep === 47 || sep === BACKSLASH) return text;
      }
      return '';
    }

    /** The file a memory row belongs to: stored field, then material, then the summary. */
    function memoryFileOf(row) {
      if (row === null || row === undefined) return '';
      const stored = pathLike(row.filePath);
      if (stored !== '') return stored;
      const material = typeof row.material === 'string' ? row.material : '';
      const cut = material.indexOf('\u0000');
      if (cut >= 0) {
        const raw = material.slice(cut + 1).trim();
        if (raw.charAt(0) === '{') {
          try {
            const parsed = JSON.parse(raw);
            if (isPlainObject(parsed) === true) {
              for (const key of ['file_path', 'path', 'target_path']) {
                const hit = pathLike(parsed[key]);
                if (hit !== '') return hit;
              }
            }
          } catch {
            /* not JSON */
          }
        }
      }
      // Rows that predate `filePath` stored no other field, and theirs is the one case
      // where the summary really is the file they edited.
      return pathLike(row.summary);
    }

    /** Clicks needed before the destructive buttons in this pane act. */
    const MEMORY_PANE_CLEAR_CLICKS = 3;
    const MEMORY_PANE_DISARM_MS = 6000;

    /**
     * The learned operations of this session. Both destructive buttons are red and
     * armed: one confirm for a row, three for everything (the pane has no undo).
     */
    /**
     * What counts as "the same lesson" on the memory page. A file is a shared subject, so
     * every fingerprint touching it is one bucket; a command with no file has **no** shared
     * subject — bucketing those by `tool + ""` added two unrelated shell scripts together
     * (1 + 1 = "2/3 · 合并 2 条") while the approval row kept printing its own 1/3.
     */
    /** The fingerprint lives inside the memory key (`sid\0fp`); older payloads omit the field. */
    function rowFingerprintOf(row) {
      if (row === null || row === undefined) return '';
      if (typeof row.fingerprint === 'string' && row.fingerprint !== '') return row.fingerprint;
      const key = typeof row.key === 'string' ? row.key : '';
      const at = key.indexOf('\u0000');
      return at < 0 ? '' : key.slice(at + 1);
    }

    function memoryBucketId(tool, path, fingerprint) {
      if (path !== '') return tool + '\u0000' + path;
      const fp = fingerprint === undefined || fingerprint === null ? '' : String(fingerprint);
      return tool + '\u0000fp:' + fp;
    }

    // ─── 05 · 组件 · MemoryBody：记忆页 ───────────────────────────
    function MemoryBody(props) {
      const t = translator(props);
      const view = useStore();
      const state = React.useState({ query: '', armedFp: '', clearCount: 0, collapsed: {} });
      const ui = state[0];
      const setUi = state[1];
      const disarm = React.useRef(null);
      const patch = function (next) {
        setUi(function (prev) { return Object.assign({}, prev, next); });
      };
      const scheduleDisarm = function () {
        if (disarm.current !== null) clearTimeout(disarm.current);
        disarm.current = setTimeout(function () {
          disarm.current = null;
          patch({ armedFp: '', clearCount: 0 });
        }, MEMORY_PANE_DISARM_MS);
      };
      React.useEffect(function () {
        return function () { if (disarm.current !== null) clearTimeout(disarm.current); };
      }, []);

      const rows = memoryRows();
      const threshold = Number(settings().threshold) || 3;
      const needle = ui.query.trim().toLowerCase();
      const toolNames = [];
      for (const row of rows) {
        const name = String(row.toolName || '—');
        if (toolNames.indexOf(name) < 0) toolNames.push(name);
      }
      toolNames.sort();
      const picked = ui.tool !== undefined && toolNames.indexOf(ui.tool) >= 0 ? ui.tool : '';
      const shown = rows.filter(function (row) {
        if (picked !== '' && String(row.toolName || '—') !== picked) return false;
        if (needle === '') return true;
        return (String(row.toolName || '') + ' ' + String(row.summary || '')).toLowerCase().indexOf(needle) >= 0;
      });

      /** One row can stand for several memory rows (same file), so removal is a loop. */
      const removeBucket = function (bucket) {
        if (ui.armedFp !== bucket.id) {
          patch({ armedFp: bucket.id });
          scheduleDisarm();
          return;
        }
        patch({ armedFp: '' });
        for (const row of bucket.rows) {
          void memoryManage({ op: 'remove', session: view.sessionId, fingerprint: rowFingerprintOf(row) });
        }
      };
      const clearAll = function () {
        const next = ui.clearCount + 1;
        if (next < MEMORY_PANE_CLEAR_CLICKS) {
          patch({ clearCount: next });
          scheduleDisarm();
          return;
        }
        patch({ clearCount: 0 });
        void memoryManage({ op: 'clear', session: view.sessionId });
      };

      const toggleFile = async function (path, on) {
        const current = isPlainObject(settings().fileAutoPass) ? settings().fileAutoPass : {};
        const next = Object.assign({}, current);
        const key = view.sessionId + '\u0000' + path;
        if (on === true) next[key] = true;
        else delete next[key];
        try {
          await saveConfig(Object.assign({}, settings(), { fileAutoPass: next }));
        } catch (error) {
          /* the switch falls back to the server's answer below */
        }
        void loadFiles();
      };

      const head = h('div', { className: 'ah-memory-head', key: 'head' },
        h('span', { className: 'ah-hint' }, t('bar.memory', { n: rows.length })),
        h('button', {
          type: 'button',
          className: 'ah-btn ah-btn-danger',
          disabled: rows.length === 0,
          onClick: function () { clearAll(); },
        }, ui.clearCount === 0 ? t('memory.clear') : t('memory.confirm', { n: MEMORY_PANE_CLEAR_CLICKS - ui.clearCount })));
      // Tool filter on the left (one fifth of the row), free-text search fills the rest.
      const toolPicker = h('select', {
        className: 'ah-input ah-memory-tool',
        key: 'tool',
        value: picked,
        title: t('memory.allTools'),
        onChange: function (event) { patch({ tool: event.target.value }); },
      }, [h('option', { key: 'all', value: '' }, t('memory.allTools'))].concat(toolNames.map(function (name) {
        return h('option', { key: 'tool-' + name, value: name }, name);
      })));
      const search = h('div', { className: 'ah-mem-filter', key: 'filter' }, [
        toolPicker,
        h('input', {
          className: 'ah-input ah-memory-search',
          key: 'search',
          type: 'search',
          placeholder: t('memory.search'),
          value: ui.query,
          onChange: function (event) { patch({ query: event.target.value }); },
        }),
      ]);
      if (rows.length === 0) {
        return h('div', { className: 'ah-memory-pane' }, [head, search, h('div', { className: 'ah-empty', key: 'e' }, t('empty.memory'))]);
      }
      // One group per tool, and inside it one row per file: twelve edits of the same
      // yml are one thing a human approved repeatedly, not twelve separate lessons.
      const fileMode = settings().fileFingerprint === true;
      const armedFiles = isPlainObject(settings().fileAutoPass) ? settings().fileAutoPass : {};
      const groups = [];
      const byTool = new Map();
      for (const row of shown) {
        const tool = String(row.toolName || '—');
        let group = byTool.get(tool);
        if (group === undefined) {
          group = { tool: tool, buckets: [], byFile: new Map(), lastTs: 0, hits: 0, hitTs: 0 };
          byTool.set(tool, group);
          groups.push(group);
        }
        const path = memoryFileOf(row);
        const bucketId = memoryBucketId(tool, path, rowFingerprintOf(row));
        let bucket = group.byFile.get(bucketId);
        if (bucket === undefined) {
          bucket = { id: bucketId, tool: tool, path: path, rows: [], max: 0, sum: 0, lastTs: 0, delta: null };
          group.byFile.set(bucketId, bucket);
          group.buckets.push(bucket);
        }
        bucket.rows.push(row);
        bucket.max = Math.max(bucket.max, Number(row.count) || 0);
        bucket.sum += Number(row.count) || 0;
        bucket.lastTs = Math.max(bucket.lastTs, Number(row.lastTs) || 0);
        const one = memoryDelta(row);
        if (one !== null) {
          bucket.delta = bucket.delta === null ? { add: one.add, del: one.del } : { add: bucket.delta.add + one.add, del: bucket.delta.del + one.del };
        }
      }
      // The counter that matters is the file's human approvals — the same number the
      // approval rows print and the answerer's threshold uses. bucket.max is only the
      // best single memory row, which is why the two pages disagreed.
      const filesByPath = new Map();
      for (const item of Array.isArray(view.files) ? view.files : []) {
        if (isPlainObject(item) === true && typeof item.path === 'string') filesByPath.set(item.path, Number(item.count) || 0);
      }
      for (const group of groups) {
        for (const bucket of group.buckets) {
          bucket.count = bucket.path !== '' && filesByPath.has(bucket.path)
            ? filesByPath.get(bucket.path)
            : bucket.sum;
          group.lastTs = Math.max(group.lastTs, bucket.lastTs);
          if (bucket.count >= threshold) {
            group.hits += bucket.count;
            group.hitTs = Math.max(group.hitTs, bucket.lastTs);
          }
        }
        group.buckets.sort(function (a, b) { return b.lastTs - a.lastTs; });
      }
      groups.sort(function (a, b) { return b.lastTs - a.lastTs; });
      const list = groups.length === 0
        ? [h('div', { className: 'ah-empty', key: 'none' }, t('memory.emptySearch'))]
        : groups.map(function (group) {
          const folded = ui.collapsed[group.tool] === true;
          return h('div', { className: 'ah-mem-group', key: 'g-' + group.tool }, [
            h('button', {
              type: 'button',
              className: 'ah-mem-group-head',
              key: 'head',
              'aria-expanded': folded === true ? 'false' : 'true',
              onClick: function () {
                const next = Object.assign({}, ui.collapsed);
                if (next[group.tool] === true) delete next[group.tool];
                else next[group.tool] = true;
                patch({ collapsed: next });
              },
            },
              h('span', { className: 'ah-mem-group-meta' }, icon(folded ? 'chevronDown' : 'chevronUp', 14)),
              h('span', { className: 'ah-mem-group-tool' }, group.tool),
              h('span', { className: 'ah-mem-group-meta' }, group.hits > 0
                ? t('memory.groupHits', { n: group.buckets.length, hits: group.hits, time: stampOf(group.hitTs) })
                : t('memory.groupCount', { n: group.buckets.length }))),
          ].concat(folded === true ? [] : group.buckets.map(function (bucket) {
            const armed = ui.armedFp === bucket.id;
            const armedFile = bucket.path === '' ? false : armedFiles[view.sessionId + '\u0000' + bucket.path] === true;
            const learned = bucket.count >= threshold;
            return h('div', { className: 'ah-mem-row', key: bucket.id },
              h('div', { className: 'ah-mem-row-head', key: 'head' },
                h('span', { className: 'ah-tool' }, bucket.tool),
                bucket.count > threshold
                  ? h('span', { className: 'ah-mem-progress', key: 'full' }, t('memory.full'))
                  : h('span', { className: 'ah-mem-progress', key: 'progress' }, t('memory.progress', { count: bucket.count, threshold: threshold })),
                bucket.rows.length > 1
                  ? h('span', { className: 'ah-mem-progress', key: 'count' }, t('memory.merged', { n: bucket.rows.length }))
                  : null,
                // Per-file opt-in only exists while the global file mode is off, and only
                // once this file has actually been approved enough times to mean it.
                h('span', { className: 'ah-mem-actions', key: 'actions' },
                  (fileMode === true || bucket.path === '')
                    ? null
                    : h('button', {
                    type: 'button',
                    className: 'ah-switch' + (armedFile === true ? ' ah-switch-on' : ''),
                    role: 'switch',
                    'aria-checked': armedFile === true ? 'true' : 'false',
                    // Shown but not yet usable: the switch only does something once the
                    // file has been approved enough times to mean it.
                    disabled: learned !== true,
                    title: t('memory.fileAutoHint'),
                    onClick: function () { void toggleFile(bucket.path, armedFile !== true); },
                  }, h('span', { className: 'ah-switch-knob' })),
                  h('button', {
                    type: 'button',
                    className: 'ah-btn ah-btn-danger',
                    onClick: function () { removeBucket(bucket); },
                  }, armed ? t('memory.removeConfirm') : t('memory.remove')))),
              h('div', { className: 'ah-mem-row-sub', key: 'sub' }, bucket.path === '' ? String(bucket.rows[0].summary || '—') : bucket.path));
          })));
        });
      return h('div', { className: 'ah-memory-pane' }, [head, search].concat(list));
    }

    /** The sidebar seat for the memory list; the inline block stays as the fallback. */
    function MemoryTab(props) {
      return h('div', { className: 'ah-panel ah-memory-tab' }, h(MemoryBody, {
        locale: props === null || props === undefined ? undefined : props.locale,
      }));
    }
    /**
     * The reviewer's counters, on their own surface. They used to be two hint spans in
     * the toolbar, which is where a number nobody can act on goes to die.
     */
    // ─── 05 · 组件 · StatsPanel：统计页 ───────────────────────────
    function StatsPanel(props) {
      const t = translator(props);
      const sessionId = props !== null && props !== undefined && typeof props.sessionId === 'string' ? props.sessionId : '';
      const state = React.useState(null);
      const data = state[0];
      const setData = state[1];

      React.useEffect(function () {
        let alive = true;
        const load = function () {
          void api('/stats?session=' + encodeURIComponent(sessionId)).then(function (body) {
            if (alive === true) setData(isPlainObject(body) ? body : null);
          }).catch(function () { /* keep the last numbers */ });
        };
        load();
        const timer = setInterval(load, 5000);
        return function () { alive = false; clearInterval(timer); };
      }, [sessionId]);

      const tally = isPlainObject(data) ? data : {};
      const reviewer = isPlainObject(tally.reviewer) ? tally.reviewer : null;
      const lanes = reviewer !== null && isPlainObject(reviewer.byModel) ? reviewer.byModel : {};
      const laneNames = Object.keys(lanes);
      const num = function (value) { return Number(value) || 0; };

      // The reviewer numbers are a suffix of the approval totals, not a second box: they
      // answer "of these approvals, how many did the AI pass / hand back / fail to judge",
      // which only makes sense next to the total.
      const totals = [
        t('bar.strip', {
          total: num(tally.total), allow: num(tally.allow), deny: num(tally.deny),
          cancelled: num(tally.cancelled), unavailable: num(tally.unavailable),
        }),
      ].filter(function (line) { return line !== ''; });
      // "Cache 12 entries" is the pool; "10 hits" is this session. Two different scopes, so
      // they are two different sentences rather than a fraction pretending to be one.
      const aiLines = reviewer === null
        ? []
        : [
          t('stats.reviewerInline', { allow: num(reviewer.allows), ask: num(reviewer.asks), fallback: num(reviewer.fallbacks) }),
          t('stats.cacheLine', { total: num(reviewer.cacheSize), hits: num(reviewer.cacheHits) }),
          t('stats.tokensLine', {
            input: num(reviewer.promptTokens),
            output: num(reviewer.completionTokens),
            cached: num(reviewer.cacheReadTokens),
          }),
        ];

      return h('div', { className: 'ah-panel ah-stats-tab' }, [
        h('div', { className: 'ah-section', key: 'sec-totals' }, t('stats.totals')),
        h('div', { className: 'ah-stat-line', key: 'totals' }, totals.join(' · ')),
        reviewer === null && laneNames.length === 0 ? null : h('div', { className: 'ah-section', key: 'sec-lanes' }, t('stats.lanes')),
        ...aiLines.map(function (line, index) {
          return h('div', { className: 'ah-stat-line', key: 'ai-' + index }, line);
        }),
        ...laneNames.map(function (name) {
          const bucket = lanes[name] || {};
          return h('div', { className: 'ah-stat-line ah-stat-lane', key: 'lane-' + name }, [
            h('span', { className: 'ah-stat-lane-name', key: 'name' }, name),
            h('span', { key: 'vals' }, [
              t('stats.calls') + ' ' + num(bucket.calls),
              ' · ' + t('stats.allow') + ' ' + num(bucket.allows),
              ' · ' + t('stats.ask') + ' ' + num(bucket.asks),
              ' · ' + t('stats.fallback') + ' ' + num(bucket.fallbacks),
              ' · ' + t('stats.cache') + ' ' + num(bucket.cacheHits),
              ' · ' + t('stats.tokens') + ' ' + num(bucket.promptTokens) + '/' + num(bucket.completionTokens),
              ' · ' + t('stats.hitRate') + ' ' + (num(bucket.promptTokens) === 0 ? '—' : Math.round((num(bucket.cacheReadTokens) / num(bucket.promptTokens)) * 100) + '%'),
            ].join('')),
          ]);
        }),
      ]);
    }

    /** The sidebar seat for the counters; same shape as the settings seat. */
    function StatsTab(props) {
      return h('div', { className: 'ah-panel' }, h(StatsPanel, {
        sessionId: props === null || props === undefined ? undefined : props.sessionId,
        locale: props === null || props === undefined ? undefined : props.locale,
      }));
    }
    /** Settings, shown in the right sidebar; the inline panel stays as the fallback. */
    function SettingsTab(props) {
      return h('div', { className: 'ah-panel ah-settings-tab' }, h(SettingsPanel, { locale: props === null || props === void 0 ? undefined : props.locale }));
    }

    /** The reviewer-lane menu: refreshed whenever settings opens, throttled otherwise. */
    let modelsAt = 0;
    async function loadModels(force, opts) {
      const now = Date.now();
      const refresh = opts !== null && opts !== undefined && opts.refresh === true;
      if (force !== true && refresh !== true && now - modelsAt < 3000) return;
      modelsAt = now;
      try {
        const body = await api('/models?session=' + encodeURIComponent(store.sessionId) + (refresh === true ? '&refresh=1' : ''));
        if (isPlainObject(body)) {
          store.models = body;
          notify();
        }
      } catch (error) {
        /* no catalog: the text input is still there */
      }
    }

    /** Same entry point for the counters: the sidebar seat, nothing inline. */
    function openStats() {
      if (sideAvailable === true && typeof sideOpenStats === 'function') {
        sideOpenStats();
        return;
      }
      // No right sidebar on this host: fall back to the settings seat rather than
      // leaving a button that does nothing.
      openSettings();
    }

    /** Memory on its own surface: the inline block could not scroll, the pane can. */
    function openMemory() {
      if (sideAvailable === true && typeof sideOpenMemory === 'function') {
        store.showMemory = false;
        store.memory = null;
        void loadMemory(true);
        sideOpenMemory();
        return;
      }
      store.showMemory = store.showMemory !== true;
      notify();
    }

    /** One entry point for "open settings": sidebar when the host has one. */
    function openSettings() {
      loadModels(true);
      if (sideAvailable === true && typeof sideOpenSettings === 'function') {
        store.settingsOpen = false;
        notify();
        sideOpenSettings();
        return;
      }
      store.settingsOpen = store.settingsOpen !== true;
      notify();
    }

    /** The diff tab's body: the same panel a row used to expand, in the sidebar. */
    function DiffPanel(props) {
      const t = translator(props);
      const view = useStore();
      if (view.diff === null) return h('div', { className: 'ah-panel' }, h('div', { className: 'ah-empty' }, t('diff.none')));
      return h('div', { className: 'ah-panel' }, renderDiff(t, view));
    }

    function apply(ctx) {
      try {
        const style = document.createElement('style');
        style.setAttribute('data-review-hub', '1');
        style.textContent = CSS;
        document.head.appendChild(style);
        if (typeof ctx.effect === 'function') ctx.effect(function () { return function () { style.remove(); }; }, 'review-hub: styles');
      } catch (error) {
        console.error('[review-hub] stylesheet failed', error);
      }

      const slots = ctx.slots;
      if (slots === null || typeof slots !== 'object' || typeof slots.register !== 'function') {
        console.error('[review-hub] slot service missing; client UI not mounted');
        return;
      }

      try {
        const register = function () { ctx.locale.register(NS, { zh: zh, en: en }); };
        if (typeof ctx.effect === 'function') ctx.effect(register, 'review-hub: dictionaries');
        else register();
      } catch (error) {
        console.error('[review-hub] locale register failed', error);
      }

      /** @returns {boolean} whether the seat really registered (a host may lack it). */
      const mount = function ($0, component) {
        try {
          if (typeof slots.inject === 'function') slots.inject($0.name, function () { return slots.register($0, component); });
          else slots.register($0, component);
          return true;
        } catch (error) {
          console.error('[review-hub] slot ' + $0.name + ' failed', error);
          return false;
        }
      };

      // conversation.input.dock is the row ABOVE the input (the composer's own dock
      // is inside the input box, below it). order 30 sits under todo/queue, like
      // the host's own docks, and every card hides when there is nothing to say.
      // inject(sessionId) is what makes the cards scoped: without it the dock can
      // only see the global feed, which is how another session's approval used to
      // pop up here.
      mount({
        name: 'conversation.input.dock',
        id: 'review-hub-dock',
        order: 30,
        inject: function (sessionId) { return { sessionId: sessionId }; },
      }, HintBar);
      mount({ name: 'plugins.bundle.config', key: NS, locale: NS }, ConfigCard);
      // The tab's label is a plain string in the DOM, so the badge is a text glyph in
      // front of it (same approach memory-evolve uses). Applying a new label means
      // re-registering this one seat; every other seat stays untouched.
      const registerView = function (label) {
        if (viewDispose !== null) {
          try { viewDispose(); } catch (error) { /* already gone */ }
          viewDispose = null;
        }
        const config = {
          name: 'conversation.view',
          id: 'review-hub.view',
          order: 20,
          label: label,
          inject: function (sessionId) { return { sessionId: sessionId }; },
        };
        const offs = [];
        // Goes through slots.inject like every other seat: a host without this seat
        // must skip it (and keep the other two), not throw out of apply().
        if (typeof slots.inject === 'function') {
          try {
            offs.push(slots.inject('conversation.view', function () { return slots.register(config, ApprovalPage); }));
          } catch (error) {
            console.error('[review-hub] slot conversation.view failed', error);
          }
        } else {
          offs.push(slots.register(config, ApprovalPage));
        }
        viewDispose = function () {
          for (const off of offs) {
            try {
              if (typeof off === 'function') off();
            } catch (error) {
              /* already disposed */
            }
          }
        };
      };
      registerView(viewLabel);
      let labelTimer = null;
      pushTabLabel = function () {
        const next = store.unread > 0 ? '🔴 审批 (' + store.unread + ')' : '审批';
        if (next === viewLabel) return;
        viewLabel = next;
        if (labelTimer !== null) clearTimeout(labelTimer);
        labelTimer = setTimeout(function () {
          labelTimer = null;
          try { registerView(viewLabel); } catch (error) { console.error('[review-hub] tab label failed', error); }
        }, 300);
      };

      // Right sidebar (optional): a diff opens as its own tab there. Without the
      // service the row keeps its inline panel, so a host that has no right sidebar
      // still shows diffs — this is a placement upgrade, never a dependency.
      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['sidebarRightTabs', 'sidebarRight'], function (scoped) {
            const tabs = scoped === null || scoped === void 0 ? undefined : scoped.sidebarRightTabs;
            const nav = scoped === null || scoped === void 0 ? undefined : scoped.sidebarRight;
            if (tabs === null || typeof tabs !== 'object' || typeof tabs.register !== 'function') return;
            if (nav === null || typeof nav !== 'object' || typeof nav.openTab !== 'function') return;
            const define = function () {
              return tabs.register({
                id: TAB_KIND,
                kind: TAB_KIND,
                keepMounted: true,
                priority: 'extension',
                title: function () { return zh['diff.title']; },
              });
            };
            if (typeof ctx.effect === 'function') ctx.effect(define, 'review-hub: diff tab type');
            else define();
            mount({ name: 'sidebar.right.pane.tab', key: TAB_KIND, locale: NS, inject: function (sessionId) { return { sessionId: sessionId }; } }, DiffPanel);
            const defineSettings = function () {
              return tabs.register({
                id: SETTINGS_KIND,
                kind: SETTINGS_KIND,
                keepMounted: true,
                priority: 'extension',
                title: function () { return zh['settings.tabTitle']; },
              });
            };
            if (typeof ctx.effect === 'function') ctx.effect(defineSettings, 'review-hub: settings tab type');
            else defineSettings();
            mount({ name: 'sidebar.right.pane.tab', key: SETTINGS_KIND, locale: NS, inject: function (sessionId) { return { sessionId: sessionId }; } }, SettingsTab);
            const defineMemory = function () {
              return tabs.register({
                id: MEMORY_KIND,
                kind: MEMORY_KIND,
                keepMounted: true,
                priority: 'extension',
                title: function () { return zh['memory.tabTitle']; },
              });
            };
            if (typeof ctx.effect === 'function') ctx.effect(defineMemory, 'review-hub: memory tab type');
            else defineMemory();
            mount({ name: 'sidebar.right.pane.tab', key: MEMORY_KIND, locale: NS, inject: function (sessionId) { return { sessionId: sessionId }; } }, MemoryTab);
            sideOpenMemory = function () {
              try {
                nav.openTab(MEMORY_KIND, { revealIfOpened: true });
              } catch (error) {
                console.error('[review-hub] memory tab failed', error);
              }
            };
            const defineStats = function () {
              return tabs.register({
                id: STATS_KIND,
                kind: STATS_KIND,
                keepMounted: true,
                priority: 'extension',
                title: function () { return zh['stats.tabTitle']; },
              });
            };
            if (typeof ctx.effect === 'function') ctx.effect(defineStats, 'review-hub: stats tab type');
            else defineStats();
            mount({ name: 'sidebar.right.pane.tab', key: STATS_KIND, locale: NS, inject: function (sessionId) { return { sessionId: sessionId }; } }, StatsTab);
            sideOpenStats = function () {
              try {
                nav.openTab(STATS_KIND, { revealIfOpened: true });
              } catch (error) {
                console.error('[review-hub] stats tab failed', error);
              }
            };
            sideOpenSettings = function () {
              try {
                nav.openTab(SETTINGS_KIND, { revealIfOpened: true });
              } catch (error) {
                console.error('[review-hub] settings tab failed', error);
              }
            };
            sideOpen = function () {
              try {
                nav.openTab(TAB_KIND, { revealIfOpened: true });
              } catch (error) {
                console.error('[review-hub] right sidebar open failed', error);
              }
            };
            sideAvailable = true;
          });
        }
      } catch (error) {
        console.error('[review-hub] right sidebar unavailable', error);
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply: apply,
      /** Pure helpers, exercised by the smoke tests without a DOM. */
      __test: {
        shouldHint: shouldHint,
        unreadCount: unreadCount,
        dividerAt: dividerAt,
        hintMsOf: hintMsOf,
        cardNode: cardNode,
        countdownRing: countdownRing,
        cardChipClass: cardChipClass,
        ringTiming: ringTiming,
        laneParts: laneParts,
        knobKeys: KNOB_KEYS,
        configCard: ConfigCard,
        aiEscalated: aiEscalated,
        chipOf: chipOf,
        memoryText: memoryText,
        isMerged: isMerged,
        memoryBucketId: memoryBucketId,
        rowFingerprintOf: rowFingerprintOf,
        riskLabel: riskLabel,
        reasonBlockOf: reasonBlockOf,
        approvalRowNode: approvalRowNode,
        rowModelOf: rowModelOf,
      },
    };
  },
});
