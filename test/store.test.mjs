import { assertEqual, assertTrue, freshRoot } from './helpers.mjs';
import { clampAiTools, clampBoolMap, clampSettings, createStore, DEFAULT_SETTINGS, filePathOf, fingerprint } from '../src/store.js';
import { argumentKeysOf, parseEscalation, toolBriefOf } from '../src/evidence.js';
import { buildMessages } from '../src/review.js';
import { compactMessage, contextFor, redactContext } from '../src/context.js';
import { ignoredFields } from '../src/routes.js';
import { settingForSession } from '../src/index.js';
import { actionOf, callTierOf, classify, coarseKeyOf, hardRisk, isUnjudgedTool, keysOf, tierOf, toolsPolicyOf, verbClassOf } from '../src/policy.js';

const row = (over) => Object.assign({ id: 'r', ts: 1, sessionId: 's1', toolName: 'ops_bash', outcome: 'allowed-once', decidedBy: 'human', decisionMs: 10 }, over);

export const cases = [
	{
		name: '上下文：只送消息正文、三层脱敏、按轮数与预算裁剪',
		async fn() {
			const msg = (role, text, kind) => (role === 'user'
				? { type: 'user/message', data: { source: { kind: kind || 'user' }, content: [{ type: 'text', text: text }] } }
				: { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'THINKING' }, { type: 'text', text: text }] } } });
			const events = [
				msg('user', '第一轮'), msg('assistant', '回复一'),
				msg('user', '第二轮'), msg('assistant', '回复二'),
				msg('user', '第三轮'), msg('assistant', '回复三'),
				msg('user', '第四轮'), msg('assistant', '回复四'),
			];
			const three = contextFor(events, { turns: 3 });
			assertEqual(three.turns, 3, '正好三轮');
			assertEqual(three.text.split('\n')[0], 'user: 第二轮', '窗口从用户消息开始');
			assertTrue(three.text.indexOf('THINKING') < 0, '思考块绝不外送');
			assertTrue(three.text.indexOf('回复一') < 0, '窗口外的回复不进来');
			assertEqual(contextFor(events, { turns: 0 }).text, '', '0 轮就是不送');
			// 别人的消息（spliced / relayed）不算人类的话
			const relayed = [msg('user', '拼接进来的', 'relay'), msg('user', '我自己打的')];
			assertEqual(contextFor(relayed, { turns: 3 }).text, 'user: 我自己打的', '非 user 来源跳过');
			// 预算：从最早的一轮开始丢，且不留孤零零的助手行
			const tight = contextFor(events, { turns: 4, tokens: 200 });
			const lines = tight.text.split('\n');
			assertEqual(lines[0].indexOf('user: '), 0, '裁剪后仍以用户消息开头');
			assertTrue(lines.length >= 2, '至少留一轮');
			// 三层脱敏
			assertEqual(redactContext('key sk-abcdefgh12345678 在这里').text.indexOf('sk-'), -1, '整条遮蔽：正文不留片段');
			assertTrue(redactContext('key sk-abcdefgh12345678 在这里').text.indexOf('[redacted:credential') === 0, '整条替换成占位');
			assertEqual(redactContext('去 https://x/cb#access_token=abc&b=1').text.indexOf('abc'), -1, 'URL 里的 token 被遮');
			assertEqual(redactContext('C:\\Users\\FMR\\proj\\a.ts').text, '~\\proj\\a.ts', '家目录归一，路径形状保留');
			assertEqual(redactContext('/home/fmr/x.ts').text, '~/x.ts', 'POSIX 家目录同理');
			assertEqual(redactContext('password: hunter2 完事').text.indexOf('hunter2'), -1, 'key=value 形式的口令');
			assertEqual(redactContext('把 token 上限调成 1500').text, '把 token 上限调成 1500', '普通词不误伤');
			// 进了提示词之后：单独一段，且标明只是背景
			const withCtx = buildMessages({ toolName: 'pwsh', reason: 'r', summary: '{}', context: 'user: 改一下 README', ctxRedactions: 2 });
			const text = withCtx.messages[0].content[0].text;
			assertTrue(text.indexOf('conversation context — background only') >= 0, '上下文要有小标题');
			assertTrue(text.indexOf('user: 改一下 README') >= 0, '上下文正文进去了');
			assertTrue(withCtx.system.indexOf('Conversation context:') >= 0, '系统提示要声明它只是背景');
			assertTrue(buildMessages({ toolName: 'pwsh', reason: 'r', summary: '{}' }).messages[0].content[0].text.indexOf('conversation context') < 0, '没有上下文就不写这一段');
			// 设置：默认值与边界
			assertEqual(clampSettings({}).aiContextEnabled, false, '上下文增强默认关');
			assertEqual(clampSettings({ aiContextEnabled: true }).aiContextEnabled, true, '能打开');
			assertEqual(clampSettings({ aiContextEnabled: 'yes' }).aiContextEnabled, false, '非布尔值不打开');
			assertEqual(clampSettings({}).aiContextTurns, 2, '默认 2 轮');
			assertEqual(clampSettings({}).aiContextTokens, 1500, '默认 1500 token');
			assertEqual(clampSettings({ aiContextTurns: 0 }).aiContextTurns, 0, '0 是关掉');
			assertEqual(clampSettings({ aiContextTurns: 99 }).aiContextTurns, 10, '轮数封顶 10');
			assertEqual(clampSettings({ aiContextTokens: 1 }).aiContextTokens, 200, 'token 下限 200');
			// 版本不一致时，认不出的键要被点名，而不是无声丢掉
			assertEqual(ignoredFields({ aiContextTurns: 2 }).join(','), '', '认得的键不报');
			assertEqual(ignoredFields({ aiContextTurns: 2, aiSomethingNew: 1 }).join(','), 'aiSomethingNew', '认不出的键要点名');
			assertEqual(ignoredFields(null).length, 0, '缺 body 不抛');
			assertEqual(ignoredFields('nope').length, 0, '非对象不抛');
			// 按会话独立：键存在就是决定，false 不能被当成「没有」而回落到全局
			const settings = { aiContextEnabled: true, aiContextLocal: { s1: false, s2: true } };
			assertEqual(settingForSession(settings, 's1', 'aiContextEnabled', 'aiContextLocal'), false, '本会话的 false 要生效');
			assertEqual(settingForSession(settings, 's2', 'aiContextEnabled', 'aiContextLocal'), true, '本会话的 true 要生效');
			assertEqual(settingForSession(settings, 's3', 'aiContextEnabled', 'aiContextLocal'), true, '没有本会话的键才用全局');
			assertEqual(settingForSession({}, '', 'aiContextEnabled'), false, '缺设置不抛且为关');
			assertEqual(settingForSession({ aiToolBrief: true, aiToolBriefLocal: { s1: false } }, 's1', 'aiToolBrief'), false, '工具说明同理');
			assertEqual(clampBoolMap({ a: true, b: false, '': true, c: 'yes', d: 1 }).a, true, '收布尔值');
			assertEqual(Object.keys(clampBoolMap({ a: true, '': true, c: 'yes', d: 1 })).join(','), 'a', '非布尔与空键丢掉');
			assertEqual(clampSettings({ aiContextLocal: { s1: false } }).aiContextLocal.s1, false, '设置层保住 false');
			assertEqual(JSON.stringify(clampSettings({ aiContextLocal: 'nope' }).aiContextLocal), '{}', '脏值回落空表');
			// 粘贴型消息（日志 / diff / 配置）只留首行 + 行数，这是省 token 的大头
			const paste = ['第一行：跑一下构建', 'line2', 'line3', 'line4', 'line5'].join('\n');
			assertEqual(compactMessage(paste, 320), '第一行：跑一下构建 …（5 行）', '多行压成首行 + 行数');
			assertEqual(compactMessage('短句', 320), '短句', '短消息不动');
			assertTrue(compactMessage('x'.repeat(400), 320).length <= 321, '超长截断加省略号');
			const withPaste = contextFor([{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: paste }] } }], { turns: 2 });
			assertTrue(withPaste.text.indexOf('…（5 行）') >= 0, '上下文里也压');
		},
	},
	{
		name: '提权语义：mode 单列，样板尾句丢弃，说明只取首句',
		async fn() {
			// 台账里真实的一条：整句被人和模型一起读时，样板尾句会把只读操作说成危险。
			const real = 'escalate sandbox to danger-full-access: plugin_manager {"action":"list_plugins","limit":3}. Profile changes persist across sessions; installed Host code runs outside the workspace sandbox.';
			const split = parseEscalation(real);
			assertEqual(split.mode, 'danger-full-access', 'mode 抽出来当字段');
			assertEqual(split.operation, 'plugin_manager {"action":"list_plugins","limit":3}', '操作只留工具名与参数，尾句丢弃');
			assertTrue(split.operation.indexOf('persist') < 0, '样板句不进操作');
			// 没有参数的提权句：保留正文，仍然丢掉宿主追加的那句。
			const noArgs = parseEscalation('escalate sandbox to workspace-write: write outside the root. Profile changes persist across sessions.');
			assertEqual(noArgs.mode, 'workspace-write', '权限名照收');
			assertEqual(noArgs.operation, 'write outside the root.', '只丢样板句');
			// 不是提权的 reason 原样返回，mode 为空：否则普通理由会被误读出权限。
			const plain = parseEscalation('why I need this');
			assertEqual(plain.mode, '', '非提权没有 mode');
			assertEqual(plain.operation, 'why I need this', '非提权不改文本');
			assertEqual(parseEscalation(undefined).mode, '', '缺 reason 不抛');
			assertEqual(toolBriefOf('Executes a command in a fresh shell. Needs approval.'), 'Executes a command in a fresh shell.', '说明只取首句');
			assertEqual(toolBriefOf('   '), '', '空说明给空串，不编');
			assertTrue(toolBriefOf('x'.repeat(400)).length <= 160, '首句有长度上限');
			assertEqual(argumentKeysOf({ properties: { action: {}, limit: {} } }), 'action, limit', '顶层参数名');
			assertEqual(argumentKeysOf({ properties: null }), '', '没有 schema 就空');
			assertEqual(argumentKeysOf(undefined), '', '缺参数不抛');
			// 读者看到的两行：权限与操作分开，说明只在有值时出现。
			const withAll = buildMessages({ toolName: 'plugin_manager', reqMode: 'danger-full-access', toolBrief: 'Manages plugins.', argKeys: 'action, target', reason: split.operation, summary: '{}', priorApprovals: 0 });
			const text = withAll.messages[0].content[0].text;
			assertTrue(text.indexOf('requested permission: danger-full-access') >= 0, '权限单独一行');
			assertTrue(text.indexOf('tool brief: Manages plugins.') >= 0, '说明单独一行');
			assertTrue(text.indexOf('argument keys: action, target') >= 0, '参数名单独一行');
			assertTrue(text.indexOf('escalate sandbox to') < 0, '提示里不再出现宿主原句');
			const bare = buildMessages({ toolName: 'x', reason: 'r', summary: '{}' }).messages[0].content[0].text;
			assertTrue(bare.indexOf('requested permission') < 0, '没有 mode 就不写这一行');
			assertTrue(bare.indexOf('tool brief') < 0, '没有说明就不写这一行');
			assertEqual(clampSettings({}).aiToolBrief, true, '说明开关默认开');
			assertEqual(clampSettings({ aiToolBrief: false }).aiToolBrief, false, '能关掉');
			assertEqual(clampSettings({ aiToolBrief: 'yes' }).aiToolBrief, true, '非布尔值不覆盖');
		},
	},
	{
		name: 'aiTools：内置基线 + 追加 + 黑名单（记忆档不许被放宽）',
		async fn() {
			assertEqual(clampAiTools([' ops_bash ', 'ops_bash', '', 3, 'x'.repeat(81), 'read']).join(','), 'ops_bash,read');
			const base = toolsPolicyOf({});
			assertEqual(tierOf('ops_bash', base), 'ai', '内置基线：shell');
			assertEqual(tierOf('ops_glob', base), 'ai', '内置基线：只读检索');
			assertEqual(tierOf('browser_click', base), 'human', '基线之外默认问人');
			assertEqual(tierOf('edit', base), 'memory', '记忆档独立于 AI 基线');
			const added = toolsPolicyOf({ aiTools: ['browser_snapshot'] });
			assertEqual(tierOf('browser_snapshot', added), 'ai', '追加名单升到 AI 档');
			assertEqual(tierOf('ops_bash', added), 'ai', '追加不改变内置基线');
			const denied = toolsPolicyOf({ aiToolsDeny: ['pwsh', 'browser_snapshot'], aiTools: ['browser_snapshot'] });
			assertEqual(tierOf('pwsh', denied), 'human', '黑名单盖掉内置基线');
			assertEqual(tierOf('browser_snapshot', denied), 'human', '黑名单盖掉追加名单');
			assertEqual(tierOf('ops_bash', denied), 'ai', '黑名单只影响点名的工具');
			assertEqual(tierOf('edit', toolsPolicyOf({ aiToolsDeny: ['edit'] })), 'memory', '黑名单也不能把记忆档降级');
			assertEqual(clampSettings({ aiTools: ['a', 'a', 'b'] }).aiTools.join(','), 'a,b', '设置里也去重');
			assertEqual(clampSettings({ aiTools: ['ops_bash', 'read_page', 'browser_click'] }).aiTools.join(','), 'browser_click', '内置基线不占设置的位置');
			// 只读组进 AI 面之后，读凭据类文件必须仍然落在硬风险上（读=泄露）。
			for (const path of ['C:/repo/.env', '/x/app.pem', 'C:/x/credentials.json', 'C:/u/.dsh/channel-pack/state.json']) {
				const risk = hardRisk('ops_read_files', JSON.stringify({ files: [{ path }] }));
				assertEqual(risk === undefined ? '' : risk.rule, 'credentials', path + ' 必须算凭据硬风险');
			}
			assertEqual(hardRisk('ops_read_files', JSON.stringify({ files: [{ path: 'D:/x/.environment.md' }] })), undefined, '.environment 不是 .env');
			// S3：命令类规则只判「能执行命令的工具」。写一段含 rm -rf 的文档不是删除。
			const doc = JSON.stringify({ file_path: 'D:/x/README.md', new_string: '用 rm -rf 清理缓存' });
			assertEqual(hardRisk('edit', doc), undefined, '内容里写着 rm -rf 的编辑不算删除类硬风险');
			assertEqual(hardRisk('write', doc), undefined, 'write 同理');
			assertEqual((hardRisk('ops_bash', JSON.stringify({ command: 'rm -rf /tmp/x' })) || {}).rule, 'delete', 'shell 工具照旧');
			assertEqual((hardRisk('run_code', JSON.stringify({ code: 'rm -rf /tmp/x' })) || {}).rule, 'delete', 'run_code 能执行，照旧');
			assertEqual((hardRisk('edit', JSON.stringify({ file_path: 'C:/x/.env' })) || {}).rule, 'credentials', '路径类规则对所有工具生效');
		},
	},
	{
		name: 'record/query：按会话过滤、ts 降序、同 callId 合并成一行',
		async fn() {
			const store = createStore({ root: await freshRoot('store-query') });
			await store.record(row({ id: 'a', ts: 1, callId: 'c1' }));
			await store.record(row({ id: 'b', ts: 2, callId: 'c2' }));
			await store.record(row({ id: 'a2', ts: 1, callId: 'c1', decidedBy: 'memory' }));
			const all = await store.query({ session: 's1' });
			assertEqual(all.entries.length, 2, '同一 callId 只留一行');
			assertEqual(all.entries[0].id, 'b', '最新在上');
			assertEqual(all.entries[1].decidedBy, 'memory', '后写的字段覆盖');
		},
	},
	{
		name: '动作档位：mixed 工具按动作判，未知动词一律人工',
		async fn() {
			const base = toolsPolicyOf({});
			const call = (tool, action) => callTierOf(tool, action === undefined ? '{}' : JSON.stringify({ action }), base);
			assertEqual(actionOf('{"action":" list_bundles "}'), 'list_bundles');
			assertEqual(actionOf('{"action":"list_bundles"'), '', '截断的参数不猜');
			assertEqual(verbClassOf('list_version_exemptions'), 'read');
			assertEqual(verbClassOf('remove_bundle'), 'write');
			assertEqual(verbClassOf('frobnicate'), '');
			// 全量动作清单：28 个组合，逐个钉死
			const expected = {
				plugin_manager: { list_plugins: 'ai', list_bundles: 'ai', list_version_exemptions: 'ai', install_bundle: 'human', remove_bundle: 'human', set_plugin: 'human', set_bundle: 'human', set_version_exemption: 'human' },
				memory: { list: 'ai', expand: 'ai', add: 'memory', replace: 'memory', archive: 'memory', remove: 'human' },
				dtodo: { list: 'ai', add: 'memory', done: 'memory', update: 'memory', remove: 'memory' },
				skill_manage: { read: 'human', list: 'human', create: 'human', patch: 'human' },
				update_goal: { edit: 'human', pause: 'human', resume: 'human', complete: 'human', blocked: 'human' },
			};
			let total = 0;
			for (const [tool, actions] of Object.entries(expected)) {
				for (const [action, tier] of Object.entries(actions)) {
					assertEqual(call(tool, action), tier, tool + '.' + action);
					total += 1;
				}
			}
			assertEqual(total, 28, '夹具覆盖全部动作');
			// 未知动词 / 没有 action / 截断 → 人工
			assertEqual(call('plugin_manager', 'frobnicate'), 'human');
			assertEqual(call('plugin_manager'), 'human', '没有 action 的 plugin_manager 仍是人工');
			assertEqual(callTierOf('plugin_manager', '{"action":"install_bu', base), 'human', '截断参数 → 人工');
			// 本地账本归 memory；外部副作用与未知工具落人工
			assertEqual(call('task_board_create'), 'memory');
			assertEqual(call('team_task_create'), 'memory');
			assertEqual(call('todo_write'), 'memory');
			assertEqual(call('fact_register'), 'memory');
			assertEqual(call('browser_click'), 'human');
			assertEqual(call('de_channel_send'), 'human');
			// 既有档位不受影响：记忆档最强，AI 基线照旧
			assertEqual(call('edit', undefined), 'memory');
			assertEqual(call('ops_bash'), 'ai');
			assertEqual(call('write'), 'memory');
			// 用户显式加白可以整工具抬到 ai；黑名单可以整工具压回人工
			assertEqual(callTierOf('plugin_manager', '{"action":"install_bundle"}', toolsPolicyOf({ aiTools: ['plugin_manager'] })), 'ai', '显式加白压过动作档');
			assertEqual(callTierOf('memory', '{"action":"list"}', toolsPolicyOf({ aiToolsDeny: ['memory'] })), 'human', '黑名单压过只读动作');
		},
	},
	{
		name: 'D 粗筛：只对“没人裁决”的工具生效，命中即人工且不进记忆',
		async fn() {
			const base = toolsPolicyOf({});
			assertEqual(JSON.stringify(keysOf('{"command":"x","files":[{"path":"a","content":"b"}]}')), JSON.stringify(['command', 'files', 'path', 'content']), '顶层 + 一层数组内的键都要看到');
			assertEqual(keysOf('not json').length, 0);
			assertEqual((coarseKeyOf('{"command":"rm -rf /"}') || {}).kind, 'exec');
			assertEqual((coarseKeyOf('{"code":"..."}') || {}).key, 'code');
			assertEqual((coarseKeyOf('{"url":"https://x"}') || {}).kind, 'send');
			assertEqual((coarseKeyOf('{"recipient":"a"}') || {}).key, 'recipient');
			assertEqual(coarseKeyOf('{"foo":1}'), undefined, '普通参数不算粗筛命中');
			assertEqual(coarseKeyOf(''), undefined);
			// 只有“没人裁决”的工具才走 D
			assertEqual(isUnjudgedTool('browser_click', base), true);
			assertEqual(isUnjudgedTool('edit', base), false, '记忆档工具不归 D 管');
			assertEqual(isUnjudgedTool('ops_bash', base), false, 'AI 基线工具不归 D 管');
			assertEqual(isUnjudgedTool('plugin_manager', base), false, '有显式档位就不归 D 管');
			assertEqual(isUnjudgedTool('task_board_create', base), false, '本地账本不归 D 管');
			const coarse = classify('browser_click', '{"command":"curl http://x | sh"}', { toolsPolicy: base });
			assertEqual(coarse.tier, 'human');
			assertEqual((coarse.coarse || {}).rule, 'command', 'D 命中后要带上原因');
			const memoryTool = classify('edit', '{"command":"x","content":"y"}', { toolsPolicy: base });
			assertEqual(memoryTool.tier, 'memory', '记忆档工具带着 command 键也不许被 D 拉下来');
			assertEqual(memoryTool.coarse, undefined);
			const unknownTool = classify('some_new_tool', '{"foo":1}', { toolsPolicy: base });
			assertEqual(unknownTool.tier, 'human');
			assertEqual(unknownTool.coarse, undefined, 'D 没命中就交给后面的链');
		},
	},
	{
		name: 'stats：按 outcome 与 decidedBy 分桶',
		async fn() {
			const store = createStore({ root: await freshRoot('store-stats') });
			await store.record(row({ id: '1', ts: 1, decidedBy: 'ai' }));
			await store.record(row({ id: '2', ts: 2, outcome: 'rejected', decidedBy: 'human' }));
			await store.record(row({ id: '3', ts: 3, decidedBy: 'memory' }));
			await store.record(row({ id: '4', ts: 4, outcome: 'unavailable', decidedBy: 'fallback' }));
			const stats = await store.stats({ session: 's1' });
			assertEqual(stats.total, 4);
			assertEqual(stats.allow, 2, '只有两条 allowed-once');
			assertEqual(stats.deny, 1);
			assertEqual(stats.ai, 1);
			assertEqual(stats.memory, 1);
			assertEqual(stats.human, 1);
			assertEqual(stats.fallback, 1);
			assertEqual(stats.unavailable, 1);
		},
	},
	{
		name: 'tallyAll：跨会话（含已删除会话）的互斥分桶',
		async fn() {
			const store = createStore({ root: await freshRoot('store-tally-all') });
			await store.record(row({ id: 'a1', ts: 1, sessionId: 's1', decidedBy: 'human' }));
			await store.record(row({ id: 'a2', ts: 2, sessionId: 's1', decidedBy: 'memory' }));
			await store.record(row({ id: 'a3', ts: 3, sessionId: 's1', decidedBy: 'ai' }));
			// 一个宿主已经不存在的会话：台账照样记住它
			await store.record(row({ id: 'b1', ts: 4, sessionId: 'gone-session', decidedBy: 'human', aiSource: 'ai' }));
			await store.record(row({ id: 'b2', ts: 5, sessionId: 'gone-session', decidedBy: 'human', aiSource: 'cache' }));
			await store.record(row({ id: 'b3', ts: 6, sessionId: 'gone-session', outcome: 'rejected', decidedBy: 'human' }));
			await store.record(row({ id: 'b4', ts: 7, sessionId: 'gone-session', outcome: 'cancelled', decidedBy: 'external' }));
			await store.record(row({ id: 'b5', ts: 8, sessionId: 'gone-session', outcome: 'unavailable', decidedBy: 'fallback' }));
			const all = await store.tallyAll();
			assertEqual(all.sessions, 2);
			assertEqual(all.human, 1, '没人接手的人工通过');
			assertEqual(all.memory, 1);
			assertEqual(all.ai, 1);
			assertEqual(all.escalated, 2, 'AI 打回后由人决定（含缓存打回）');
			assertEqual(all.denied, 1);
			assertEqual(all.cancelled, 1);
			assertEqual(all.unavailable, 1);
			assertEqual(all.other, 0);
			assertEqual(all.total, 8);
			assertEqual(all.human + all.memory + all.ai + all.escalated + all.denied + all.cancelled + all.unavailable + all.other, all.total, '五桶互斥，加起来等于总数');
			// 跨会话的按工具计数：审批页那枚「加入 AI 预审」图标靠它判状态
			assertEqual(all.byTool.ops_bash.approved, 3, '两个会话的人工通过要合并计数');
			assertEqual(all.byTool.ops_bash.rejected, 1);
			assertEqual(all.byTool.ops_bash.total, 8);
			assertEqual(all.byTool.edit, undefined, '没出现过的工具不占位');
		},
	},
	{
		name: 'stats：审查器合计按台账行派生（重启不丢、缓存不算调用、失败计入调用）',
		async fn() {
			const store = createStore({ root: await freshRoot('store-stats-reviewer') });
			// 三条审批都经过 AI：两条被打回（人工裁决）、一条 AI 直接放行。
			await store.record(row({ id: 'r1', ts: 1, decidedBy: 'human', aiSource: 'ai', aiModel: 'p/rev', aiReason: 'needs a human' }));
			await store.record(row({ id: 'r2', ts: 2, decidedBy: 'human', aiSource: 'ai', aiModel: 'p/rev', aiReason: 'also' }));
			await store.record(row({ id: 'r3', ts: 3, decidedBy: 'ai', aiSource: 'ai', aiModel: 'p/rev', aiReason: 'safe' }));
			await store.record(row({ id: 'r4', ts: 4, decidedBy: 'human', aiSource: 'cache', aiModel: 'p/rev' }));
			await store.record(row({ id: 'r5', ts: 5, decidedBy: 'human', aiSource: 'error' }));
			await store.record(row({ id: 'r6', ts: 6, decidedBy: 'memory' }));
			const stats = await store.stats({ session: 's1' });
			assertEqual(stats.reviewer.calls, 4, '调用 = 实际发出的请求（ai + error；cache 不算）');
			assertEqual(stats.reviewer.allows, 1);
			assertEqual(stats.reviewer.asks, 3, '打回两条 + 缓存打回一条');
			assertEqual(stats.reviewer.cacheHits, 1);
			assertEqual(stats.reviewer.fallbacks, 1, 'error 是兜底');
			assertEqual(stats.reviewer.byModel['p/rev'].calls, 3, '按车道分组');
			assertEqual(stats.reviewer.byModel['(unknown)'].fallbacks, 1, '没有车道信息的行归到 unknown');
			assertEqual(stats.reviewer.byModel['(unknown)'].calls, 1, '失败也计入调用，否则调用数与明细对不上');
			assertEqual(stats.reviewer.byModel['p/rev'].lastTs, 4, '车道最后活跃时间');
			assertEqual((await store.stats({ session: 'other-session' })).reviewer.calls, 0, '按会话隔离');
		},
	},
	{
		name: 'stats：AI 返回时间按模型平均，缓存命中不算一次调用',
		async fn() {
			const store = createStore({ root: await freshRoot('store-ai-ms') });
			await store.record(row({ id: 'm1', ts: 1, decidedBy: 'ai', aiSource: 'ai', aiModel: 'p/rev', aiMs: 1000 }));
			await store.record(row({ id: 'm2', ts: 2, decidedBy: 'ai', aiSource: 'ai', aiModel: 'p/rev', aiMs: 3000 }));
			await store.record(row({ id: 'm3', ts: 3, decidedBy: 'human', aiSource: 'cache', aiModel: 'p/rev', aiMs: 0 }));
			await store.record(row({ id: 'm4', ts: 4, decidedBy: 'human', aiSource: 'error', aiModel: 'q/other' }));
			const stats = await store.stats({ session: 's1' });
			assertEqual(stats.reviewer.byModel['p/rev'].avgMs, 2000, '同一车道取平均');
			assertEqual(stats.reviewer.byModel['p/rev'].msCount, 2, '缓存命中不算一次模型耗时');
			assertEqual(stats.reviewer.byModel['q/other'].avgMs, 0, '没有耗时的车道给 0');
			assertEqual(stats.reviewer.avgMs, 2000, '整体也按真实调用平均');
		},
	},
	{
		name: 'memory：计数、读取、按会话隔离、清空',
		async fn() {
			const store = createStore({ root: await freshRoot('store-memory') });
			const fp = fingerprint('ops_bash', JSON.stringify({ command: 'npm test' }));
			await store.memoryBump({ sessionId: 's1', fingerprint: fp, toolName: 'ops_bash', summary: 'npm test', callId: 'c1' });
			await store.memoryBump({ sessionId: 's1', fingerprint: fp, toolName: 'ops_bash', summary: 'npm test', callId: 'c2' });
			const entry = await store.memoryEntry('s1', fp);
			assertEqual(entry.count, 2);
			assertEqual(entry.calls[0], 'c2', '最近一次调用在前');
			assertEqual(await store.memoryEntry('s2', fp), undefined, '别的会话看不到');
			assertEqual((await store.memoryRows('s1')).length, 1);
			assertEqual(await store.memoryClear('s1'), 1);
			assertEqual((await store.memoryRows('s1')).length, 0);
		},
	},
	{
		name: 'memory：老行没有 filePath 时，从它记住的调用里补回真实路径',
		async fn() {
			const store = createStore({ root: await freshRoot('store-memory-path') });
			const real = '/home/x/.dsh/profiles/desktop/cordis.patch.yml';
			const shrunk = '…/desktop/cordis.patch.yml';
			await store.record(row({ id: 'r1', ts: 1, sessionId: 's1', callId: 'c7', filePath: real }));
			await store.memoryBump({
				sessionId: 's1',
				fingerprint: 'fp-legacy',
				toolName: 'edit',
				summary: shrunk,
				material: 'edit\u0000{"file_path":"' + shrunk + '"}',
				callId: 'c7',
			});
			const rows = await store.memoryRows('s1');
			assertEqual(rows[0].filePath, real, '不能拿被压短的 material 路径当文件');
			assertEqual((await store.fileCount('s1', real)) >= 1, true, '按文件计数认得同一个路径');
		},
	},
	{
		name: 'clear：只清本会话，且水位线挡住回填',
		async fn() {
			const root = await freshRoot('store-clear');
			const store = createStore({ root });
			await store.record(row({ id: 'a', ts: 1, sessionId: 's1' }));
			await store.record(row({ id: 'b', ts: 2, sessionId: 's2' }));
			const cleared = await store.clear({ session: 's1' });
			assertEqual(cleared.cleared, 1);
			assertTrue(cleared.clearedAt > 0, '记录水位线');
			assertEqual((await store.query({ session: 's1' })).entries.length, 0);
			assertEqual((await store.query({ session: 's2' })).entries.length, 1, '别的会话不受影响');
			await store.record(row({ id: 'a-again', ts: 1, sessionId: 's1' }));
			assertEqual((await store.query({ session: 's1' })).entries.length, 0, '旧行不会被重建');
			const reopened = createStore({ root });
			assertEqual((await reopened.query({ session: 's1' })).entries.length, 0, '重开仍被水位线挡住');
			assertEqual((await store.clear({})).cleared, 0, '不许无 scope 清空');
		},
	},
	{
		name: 'settings：clamp 与嵌套 agentPolicy',
		async fn() {
			assertEqual(clampSettings({ threshold: 99 }).threshold, 5);
			assertEqual(clampSettings({ threshold: 0 }).threshold, 1);
			assertEqual(clampSettings({ pollMs: 'abc' }).pollMs, DEFAULT_SETTINGS.pollMs);
			assertEqual(clampSettings({ aiFailurePolicy: 'deny' }).aiFailurePolicy, 'ask', '不允许配置成 deny');
			assertEqual(clampSettings({ agentPolicy: { subagent: 'full' } }).agentPolicy.subagent, 'full');
			assertEqual(clampSettings({ agentPolicy: { subagent: 'nonsense' } }).agentPolicy.subagent, 'strict', '非法档位被忽略');
			// 文件级放行是逐文件的选择性加入：只保留 true，false/非法键一律丢弃。
			assertEqual(JSON.stringify(clampSettings({ fileAutoPass: { 'a\u0000x': true, 'b\u0000y': false, z: 1 } }).fileAutoPass), '{"a\\u0000x":true}', '只有显式 true 的条目留下');
			assertEqual(JSON.stringify(clampSettings({ fileAutoPass: 'nope' }).fileAutoPass), '{}', '非法形状回空表');
			// 布尔白名单漏一个键 = 开关点了没反应（0.4.28 的真实 bug），这两条锁住它。
			assertEqual(clampSettings({ fpIgnoreJustification: true }).fpIgnoreJustification, true, '开关必须能写进设置');
			assertEqual(clampSettings({ autoExpandDescription: true }).autoExpandDescription, true);
			assertEqual(clampSettings({}).fpIgnoreJustification, false, '默认关闭');
			assertEqual(filePathOf(JSON.stringify({ file_path: 'D:/a/b.txt', old_string: 'x' })), 'D:/a/b.txt');
			assertEqual(filePathOf(JSON.stringify({ command: 'ls' })), '', '没有文件路径就没有文件统计');
			assertEqual(filePathOf('git status'), '', '非 JSON 参数不算文件');
			const store = createStore({ root: await freshRoot('store-settings') });
			const written = await store.writeSettings({ toastEnabled: false, threshold: 4 });
			assertEqual(written.toastEnabled, false);
			assertEqual(written.threshold, 4);
			assertEqual(store.settingsSnapshot().threshold, 4, '同步快照立即可用');
		},
	},
	{
		name: 'settings：reviewerModelLocal 只留 string→string，空串键保留，非法整份丢弃',
		async fn() {
			const cleaned = clampSettings({ reviewerModelLocal: { s1: 'raccoon/sn-flash', s2: '', s3: 7, s4: null } }).reviewerModelLocal;
			assertEqual(Object.keys(cleaned).join(','), 's1,s2', '非字符串值被丢掉，空串值保留');
			assertEqual(cleaned.s2, '');
			assertEqual(JSON.stringify(clampSettings({ reviewerModelLocal: 'nope' }).reviewerModelLocal), '{}', '非法输入整份丢弃');
			assertEqual(JSON.stringify(clampSettings({ reviewerModelLocal: ['a'] }).reviewerModelLocal), '{}', '数组也不收');
			const long = clampSettings({ reviewerModelLocal: { ['k'.repeat(90)]: 'x'.repeat(200) } }).reviewerModelLocal;
			const longKeys = Object.keys(long);
			assertEqual(longKeys[0].length, 80, 'key 截到 80');
			assertEqual(long[longKeys[0]].length, 120, 'value 截到 120');
			const many = {};
			for (let index = 0; index < 40; index += 1) many['s' + index] = 'p/m';
			const capped = Object.keys(clampSettings({ reviewerModelLocal: many }).reviewerModelLocal);
			assertEqual(capped.length, 32, '最多 32 个键');
			assertEqual(capped[0], 's8', '超出时删最早插入的那个');
			assertEqual(capped[31], 's39');
			const store = createStore({ root: await freshRoot('store-settings-local') });
			const written = await store.writeSettings({ reviewerModelLocal: { s1: 'a/b', s2: '' } });
			assertEqual(written.reviewerModelLocal.s1, 'a/b');
			assertTrue(Object.prototype.hasOwnProperty.call(written.reviewerModelLocal, 's2'), '空串键写进去了');
			assertTrue(Object.prototype.hasOwnProperty.call(store.settingsSnapshot().reviewerModelLocal, 's2'), '快照是深拷贝，键仍在');
		},
	},
];
