import { assertEqual, assertTrue, freshRoot } from './helpers.mjs';
import { createStore, clampAiTools, clampSettings, DEFAULT_SETTINGS, filePathOf, fingerprint } from '../src/store.js';
import { hardRisk, tierOf, toolsPolicyOf } from '../src/policy.js';

const row = (over) => Object.assign({ id: 'r', ts: 1, sessionId: 's1', toolName: 'ops_bash', outcome: 'allowed-once', decidedBy: 'human', decisionMs: 10 }, over);

export const cases = [
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
