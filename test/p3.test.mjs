import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertEqual, assertTrue, callRoute, freshRoot } from './helpers.mjs';
import { createStore } from '../src/store.js';
import { createSnapshot } from '../src/snapshot.js';
import { createRoutes, ROUTES, revertInstruction } from '../src/routes.js';

const row = (over) => Object.assign({
	id: 'r', ts: Date.now(), sessionId: 's1', toolName: 'write', outcome: 'allowed-once', decidedBy: 'human',
}, over);

async function harness(name, options = {}) {
	const root = await freshRoot(name);
	const store = createStore({ root });
	const snapshot = createSnapshot({ root });
	const delivered = [];
	const agentFor = options.agentFor === null ? undefined : (sessionId) => ({
		inject: async (message) => { delivered.push(message); },
		sessionId: sessionId,
	});
	const routes = createRoutes({
		store,
		snapshot,
		agentFor,
		version: '9.9.9',
		settings: () => store.settingsSnapshot(),
		pendingView: () => [],
		answererState: () => ({ registered: true }),
	});
	const byPath = new Map(routes.map((route) => [route.path, route.handler]));
	return { root, store, snapshot, routes, byPath, delivered };
}

function exec(name, callId, sessionId, args) {
	return { callId, rootCallId: callId, name, arguments: args, agent: { id: sessionId, session: {} } };
}

export const cases = [
	{
		name: '快照：写前内容被留下，index.json 落盘',
		async fn() {
			const { root, snapshot } = await harness('p3-capture');
			const file = join(root, 'a.txt');
			await writeFile(file, 'before text', 'utf8');
			snapshot.capture(exec('write', 'c1', 's1', { file_path: file, content: 'after text' }));
			await new Promise((resolve) => setTimeout(resolve, 60));
			assertEqual(snapshot.has('s1', 'c1'), true);
			const entry = await snapshot.lookup('s1', 'c1');
			assertEqual(entry.before, 'before text');
			assertEqual(entry.afterHint, 'after text', 'write 的 content 就是改动后的样子');
			const index = JSON.parse(await readFile(join(root, 'snapshots', 's1', 'index.json'), 'utf8'));
			assertEqual(index.version, 1);
			assertTrue(index.entries.c1 !== undefined, '条目按 callId 存');
		},
	},
	{
		name: '快照：PTC 后缀 id 与基 id 互相能查到',
		async fn() {
			const { root, snapshot } = await harness('p3-ptc');
			const file = join(root, 'b.txt');
			await writeFile(file, 'x', 'utf8');
			snapshot.capture(exec('edit', 'base:ptc:1', 's1', { file_path: file, old_string: 'x', new_string: 'y' }));
			assertEqual((await snapshot.lookup('s1', 'base')) !== undefined, true, '基 id 能查到嵌套快照');
			assertEqual((await snapshot.lookup('s1', 'base:ptc:1')) !== undefined, true);
		},
	},
	{
		name: '快照：新文件 before 为 null，超大文件只留元数据',
		async fn() {
			const { root, snapshot } = await harness('p3-edge');
			const fresh = join(root, 'new.txt');
			snapshot.capture(exec('write', 'n1', 's1', { file_path: fresh, content: 'hello' }));
			const created = await snapshot.lookup('s1', 'n1');
			assertEqual(created.before, null);
			assertEqual(created.afterHint, 'hello');

			const big = join(root, 'big.txt');
			await writeFile(big, 'x'.repeat(300 * 1024), 'utf8');
			snapshot.capture(exec('write', 'big1', 's1', { file_path: big, content: 'small' }));
			const huge = await snapshot.lookup('s1', 'big1');
			assertEqual(huge.tooLarge, true);
			assertEqual(huge.before, null, '超限时不留正文');
		},
	},
	{
		name: 'diff：命中快照时给出 path/stats/hunks（双行号）',
		async fn() {
			const { root, snapshot, byPath } = await harness('p3-diff');
			const file = join(root, 'c.txt');
			await writeFile(file, 'one\ntwo\nthree\n', 'utf8');
			snapshot.capture(exec('write', 'c9', 's1', { file_path: file, content: 'one\nTWO\nthree\n' }));
			await writeFile(file, 'one\nTWO\nthree\n', 'utf8');
			const res = await callRoute(byPath.get(ROUTES.diff), { url: ROUTES.diff + '?session=s1&callId=c9' });
			assertEqual(res.status, 200);
			assertEqual(res.json.ok, true);
			assertEqual(res.json.path, file);
			assertEqual(res.json.stats.add, 1);
			assertEqual(res.json.stats.del, 1);
			const hunk = res.json.hunks[0];
			assertTrue(hunk.oldStart >= 1 && hunk.newStart >= 1, '带起始行号');
			const del = hunk.lines.find((line) => line.kind === 'del');
			const add = hunk.lines.find((line) => line.kind === 'add');
			assertEqual(del.text, 'two');
			assertEqual(del.noNew, null, '删除行没有新行号');
			assertEqual(add.text, 'TWO');
			assertEqual(add.noOld, null, '新增行没有旧行号');
		},
	},
	{
		name: 'diff：文件后来又被改过，仍只显示这一次调用的改动（并标记 drifted）',
		async fn() {
			const { root, snapshot, byPath } = await harness('p3-diff-drift');
			const file = join(root, 'd.txt');
			await writeFile(file, 'a\nb\n', 'utf8');
			snapshot.capture(exec('write', 'd1', 's1', { file_path: file, content: 'a\nB\n' }));
			// A later approval rewrites the same file; that must not be read as this call's change.
			await writeFile(file, 'a\nB\nc\nd\ne\n', 'utf8');
			const res = await callRoute(byPath.get(ROUTES.diff), { url: ROUTES.diff + '?session=s1&callId=d1' });
			assertEqual(res.json.ok, true);
			assertEqual(res.json.stats.add, 1, '只算这一次写进去的那一行');
			assertEqual(res.json.stats.del, 1);
			assertEqual(res.json.drifted, true, '文件此刻与快照不一致，要如实标记');
		},
	},
	{
		name: 'diff：四种降级各自回 ok:false + 原因，且仍是 200',
		async fn() {
			const { root, snapshot, byPath } = await harness('p3-diff-degrade');
			const handler = byPath.get(ROUTES.diff);
			const miss = await callRoute(handler, { url: ROUTES.diff + '?session=s1&callId=none' });
			assertEqual(miss.status, 200);
			assertEqual(miss.json.reason, 'no-snapshot');

			const bad = await callRoute(handler, { url: ROUTES.diff });
			assertEqual(bad.json.reason, 'bad-request');

			const gone = join(root, 'gone.txt');
			await writeFile(gone, 'old', 'utf8');
			snapshot.capture(exec('write', 'g1', 's1', { file_path: gone, content: 'new content' }));
			await (await import('node:fs/promises')).rm(gone, { force: true });
			const hint = await callRoute(handler, { url: ROUTES.diff + '?session=s1&callId=g1' });
			assertEqual(hint.json.ok, true, '文件没了但有 afterHint，仍能给出改动');
			assertEqual(hint.json.stats.add, 1);

			await writeFile(gone, 'bin\u0000ary', 'utf8');
			snapshot.capture(exec('write', 'b1', 's1', { file_path: gone, content: 'text' }));
			await writeFile(gone, '\u0000\u0001binary', 'utf8');
			const binary = await callRoute(handler, { url: ROUTES.diff + '?session=s1&callId=b1' });
			assertEqual(binary.json.reason, 'binary');
		},
	},
	{
		name: 'diff：围栏与方法门',
		async fn() {
			const { byPath } = await harness('p3-diff-fence');
			const denied = await callRoute(byPath.get(ROUTES.diff), { url: ROUTES.diff + '?session=s1', headers: { origin: 'http://evil.example' } });
			assertEqual(denied.status, 403);
			const wrongMethod = await callRoute(byPath.get(ROUTES.diff), { method: 'POST', url: ROUTES.diff });
			assertEqual(wrongMethod.status, 405);
		},
	},
	{
		name: 'revert：投递的用户消息必须带 id（否则整个会话日志不可加载）',
		async fn() {
			const { root, snapshot, byPath, delivered } = await harness('p3-revert');
			const file = join(root, 'd.txt');
			await writeFile(file, 'before', 'utf8');
			snapshot.capture(exec('write', 'd1', 's1', { file_path: file, content: 'after' }));
			const res = await callRoute(byPath.get(ROUTES.revert), { method: 'POST', url: ROUTES.revert, body: { session: 's1', callId: 'd1' } });
			assertEqual(res.json.ok, true);
			assertEqual(res.json.delivered, 'message');
			assertEqual(delivered.length, 1);
			const message = delivered[0];
			assertTrue(typeof message.id === 'string' && message.id.length >= 8, '缺 id 会让会话日志判损坏');
			assertEqual(message.role, 'user');
			const text = message.content[0].text;
			assertTrue(text.indexOf(file) >= 0, '指令里点名文件');
			assertTrue(text.indexOf('before') >= 0, '指令里说明要恢复成改动前的原文');
			assertEqual(snapshotPathOf(text).indexOf('index.json') > 0, true, '指令里给出快照文件路径');
		},
	},
	{
		name: 'revert：无 agent / 无快照 / 坏请求都是 ok:false，不抛',
		async fn() {
			const { root, snapshot, byPath } = await harness('p3-revert-miss', { agentFor: null });
			const file = join(root, 'e.txt');
			await writeFile(file, 'before', 'utf8');
			snapshot.capture(exec('write', 'e1', 's1', { file_path: file, content: 'after' }));
			const noAgent = await callRoute(byPath.get(ROUTES.revert), { method: 'POST', url: ROUTES.revert, body: { session: 's1', callId: 'e1' } });
			assertEqual(noAgent.json.ok, false);
			assertEqual(noAgent.json.reason, 'no-agent');
			const noSnap = await callRoute(byPath.get(ROUTES.revert), { method: 'POST', url: ROUTES.revert, body: { session: 's1', callId: 'zz' } });
			assertEqual(noSnap.json.reason, 'no-snapshot');
			const bad = await callRoute(byPath.get(ROUTES.revert), { method: 'POST', url: ROUTES.revert, body: {} });
			assertEqual(bad.json.reason, 'bad-request');
		},
	},
	{
		name: 'entries：每行带 hasSnapshot',
		async fn() {
			const { root, store, snapshot, byPath } = await harness('p3-flags');
			const file = join(root, 'f.txt');
			await writeFile(file, 'before', 'utf8');
			snapshot.capture(exec('write', 'f1', 's1', { file_path: file, content: 'after' }));
			await store.record(row({ id: 'a', sessionId: 's1', callId: 'f1', ts: Date.now() }));
			await store.record(row({ id: 'b', sessionId: 's1', callId: 'nope', ts: Date.now() + 1 }));
			const res = await callRoute(byPath.get(ROUTES.entries), { url: ROUTES.entries + '?session=s1' });
			const byCall = new Map(res.json.entries.map((entry) => [entry.callId, entry.hasSnapshot]));
			assertEqual(byCall.get('f1'), true);
			assertEqual(byCall.get('nope'), false);
		},
	},
	{
		name: 'revertInstruction：改动前不存在时让 agent 删除文件',
		fn() {
			const text = revertInstruction({ path: 'D:/x.txt', before: null }, 'D:/snap/index.json', 'c1');
			assertTrue(text.indexOf('删除') > 0);
			assertTrue(text.indexOf('"c1"') > 0);
		},
	},
];

function snapshotPathOf(text) {
	const at = text.indexOf('快照文件：');
	if (at < 0) return '';
	return text.slice(at + 5).split('\n')[0];
}
