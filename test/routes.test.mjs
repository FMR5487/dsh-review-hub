import { assertEqual, assertTrue, callRoute, freshRoot } from './helpers.mjs';
import { isTrusted } from '../src/routes.js';
import { createStore } from '../src/store.js';
import { createRoutes, ROUTES } from '../src/routes.js';

async function harness(name, extra = {}) {
	const store = createStore({ root: await freshRoot(name) });
	const routes = createRoutes({
		store,
		version: '9.9.9',
		settings: () => store.settingsSnapshot(),
		pendingView: () => [{ id: 'p1', sessionId: 's1', toolName: 'write' }],
		answererState: () => ({ registered: true, counters: { asked: 1 } }),
		...extra,
	});
	const byPath = new Map(routes.map((route) => [route.path, route.handler]));
	return { store, byPath };
}

const row = (over) => Object.assign({ id: 'r', ts: Date.now(), sessionId: 's1', toolName: 'ops_bash', outcome: 'allowed-once', decidedBy: 'human' }, over);

export const cases = [
	{
		name: '同源围栏：浏览器放行，裸 curl 拒绝（S2）',
		async fn() {
			const base = { host: '127.0.0.1:12345' };
			// 浏览器：同源 Origin，或没有 Origin 但有 Sec-Fetch-Site
			assertEqual(isTrusted({ headers: { ...base, origin: 'http://127.0.0.1:12345' } }), true, '同源 Origin 放行');
			assertEqual(isTrusted({ headers: { ...base, 'sec-fetch-site': 'same-origin' } }), true, 'EventSource 没有 Origin，但有 Sec-Fetch-Site');
			assertEqual(isTrusted({ headers: { ...base, origin: 'dsh-app://local' } }), true, '桌面壳协议放行');
			// 裸 HTTP 客户端：两个头都没有
			assertEqual(isTrusted({ headers: { ...base } }), false, 'curl 不带 Origin 也不带 Sec-Fetch-Site → 拒绝');
			assertEqual(isTrusted({ headers: { ...base, 'sec-fetch-site': 'cross-site' } }), false, '跨站不放行');
			assertEqual(isTrusted({ headers: { ...base, origin: 'http://evil.example' } }), false, '别的源不放行');
			assertEqual(isTrusted({ headers: { host: '10.0.0.5:12345', 'sec-fetch-site': 'same-origin' } }), false, '非回环直接拒绝');
			// 逃生舱：宿主某天不再发 Sec-Fetch-* 时由配置打开
			assertEqual(isTrusted({ headers: { ...base } }, { allowNoOrigin: true }), true, 'allowNoOrigin 是显式逃生舱');
		},
	},
	{
		name: 'health：版本、answerer、pending 与 settings 都在',
		async fn() {
			const { byPath } = await harness('routes-health');
			const res = await callRoute(byPath.get(ROUTES.health), { url: ROUTES.health });
			assertEqual(res.status, 200);
			assertEqual(res.json.version, '9.9.9');
			assertEqual(res.json.answerer.registered, true);
			assertEqual(res.json.pending, 1);
			assertEqual(res.json.settings.threshold, 3);
		},
	},
	{
		name: '围栏：非回环 Host / 跨源 Origin 一律 403',
		async fn() {
			const { byPath } = await harness('routes-fence');
			const badHost = await callRoute(byPath.get(ROUTES.entries), { url: ROUTES.entries, headers: { host: '10.0.0.5:1234' } });
			assertEqual(badHost.status, 403);
			const badOrigin = await callRoute(byPath.get(ROUTES.entries), { url: ROUTES.entries, headers: { origin: 'http://evil.example' } });
			assertEqual(badOrigin.status, 403);
			const appOrigin = await callRoute(byPath.get(ROUTES.entries), { url: ROUTES.entries, headers: { origin: 'dsh-app://app' } });
			assertEqual(appOrigin.status, 200, 'desktop 的 dsh-app:// 例外放行');
		},
	},
	{
		name: '方法门：entries 只读',
		async fn() {
			const { byPath } = await harness('routes-method');
			const res = await callRoute(byPath.get(ROUTES.entries), { method: 'POST', url: ROUTES.entries });
			assertEqual(res.status, 405);
		},
	},
	{
		name: 'entries/stats：透传 store 口径',
		async fn() {
			const { store, byPath } = await harness('routes-entries');
			await store.record(row({ id: 'a', sessionId: 's1' }));
			await store.record(row({ id: 'b', sessionId: 's2' }));
			const entries = await callRoute(byPath.get(ROUTES.entries), { url: ROUTES.entries + '?session=s1' });
			assertEqual(entries.json.entries.length, 1);
			const stats = await callRoute(byPath.get(ROUTES.stats), { url: ROUTES.stats + '?session=s1' });
			assertEqual(stats.json.total, 1);
		},
	},
	{
		name: 'config：默认值、POST 夹紧并持久化',
		async fn() {
			const { byPath } = await harness('routes-config');
			const before = await callRoute(byPath.get(ROUTES.config), { url: ROUTES.config });
			assertEqual(before.json.aiEnabled, true);
			assertEqual(before.json.clearEnabled, false);
			assertEqual(before.json.toastEnabled, true);
			const after = await callRoute(byPath.get(ROUTES.config), { method: 'POST', url: ROUTES.config, body: { threshold: 9, agentPolicy: { subagent: 'off' } } });
			assertEqual(after.json.threshold, 5, '超范围被夹紧');
			assertEqual(after.json.agentPolicy.subagent, 'off');
			const reread = await callRoute(byPath.get(ROUTES.config), { url: ROUTES.config });
			assertEqual(reread.json.agentPolicy.subagent, 'off', '写进去了');
		},
	},
	{
		name: 'clear：开关关着回 403，开着按会话清',
		async fn() {
			const { store, byPath } = await harness('routes-clear');
			await store.record(row({ id: 'a', sessionId: 's1' }));
			const off = await callRoute(byPath.get(ROUTES.clear), { method: 'POST', url: ROUTES.clear, body: { session: 's1' } });
			assertEqual(off.status, 403, '藏按钮不是防线，路由自己拦');
			await store.writeSettings({ clearEnabled: true });
			const noSession = await callRoute(byPath.get(ROUTES.clear), { method: 'POST', url: ROUTES.clear, body: {} });
			assertEqual(noSession.status, 400, '必须带 session');
			const ok = await callRoute(byPath.get(ROUTES.clear), { method: 'POST', url: ROUTES.clear, body: { session: 's1' } });
			assertEqual(ok.status, 200);
			assertEqual(ok.json.cleared, 1);
		},
	},
	{
		name: 'memory：GET 列表、POST remove / clear',
		async fn() {
			const { store, byPath } = await harness('routes-memory');
			await store.memoryBump({ sessionId: 's1', fingerprint: 'fp1', toolName: 'ops_bash', summary: 'npm test' });
			await store.memoryBump({ sessionId: 's2', fingerprint: 'fp2', toolName: 'write', summary: 'x' });
			const list = await callRoute(byPath.get(ROUTES.memory), { url: ROUTES.memory + '?session=s1' });
			assertEqual(list.json.entries.length, 1);
			assertEqual(list.json.threshold, 3);
			const removed = await callRoute(byPath.get(ROUTES.memory), { method: 'POST', url: ROUTES.memory, body: { op: 'remove', session: 's1', fingerprint: 'fp1' } });
			assertEqual(removed.json.removed, 1);
			const cleared = await callRoute(byPath.get(ROUTES.memory), { method: 'POST', url: ROUTES.memory, body: { op: 'clear', session: 's2' } });
			assertEqual(cleared.json.removed, 1);
			const bad = await callRoute(byPath.get(ROUTES.memory), { method: 'POST', url: ROUTES.memory, body: { op: 'nope', session: 's1' } });
			assertEqual(bad.status, 400);
		},
	},
	{
		name: 'export：CSV 下载头和 BOM；all 范围受设置约束',
		async fn() {
			const { store, byPath } = await harness('routes-export');
			await store.record(row({ id: 'a', sessionId: 's1', argsSummary: 'echo hi' }));
			const csv = await callRoute(byPath.get(ROUTES.export), { url: ROUTES.export + '?session=s1&format=csv' });
			assertEqual(csv.status, 200);
			assertTrue(csv.text.startsWith('\uFEFF'), 'BOM');
			assertTrue(String(csv.headers['content-disposition']).indexOf('attachment') === 0, '下载头');
			assertTrue(csv.text.indexOf('echo hi') > 0, '内容带摘要');
			const missing = await callRoute(byPath.get(ROUTES.export), { url: ROUTES.export });
			assertEqual(missing.status, 400, 'session 范围必须给 session');
			const blocked = await callRoute(byPath.get(ROUTES.export), { url: ROUTES.export + '?scope=all&format=json' });
			assertEqual(blocked.status, 403, '范围开关没打开就不许导全部');
			await store.writeSettings({ exportScope: 'all' });
			const all = await callRoute(byPath.get(ROUTES.export), { url: ROUTES.export + '?scope=all&format=json' });
			assertEqual(all.status, 200);
			assertEqual(all.json.rows.length, 1);
		},
	},
	{
		name: 'models：没有 modelCatalog 时回空壳，仍然 200',
		async fn() {
			const { byPath } = await harness('routes-models-empty');
			const res = await callRoute(byPath.get(ROUTES.models), { url: ROUTES.models });
			assertEqual(res.status, 200);
			assertEqual(res.json.providers.length, 0);
			assertEqual(res.json.observed.length, 0);
			assertEqual(res.json.models.length, 0);
			assertEqual(res.json.current, null);
			assertEqual(res.json.errors.length, 0);
			assertEqual(res.json.fetchedAt, 0);
		},
	},
	{
		name: 'models：透传 providers/observed/current，models 是 observed 的别名',
		async fn() {
			const seen = [];
			const { byPath } = await harness('routes-models-shape', {
				modelCatalog: async (session, opts) => {
					seen.push({ session, opts });
					return {
						providers: [
							{ id: 'raccoon', name: 'Raccoon', models: [{ id: 'sn-flash', name: 'Flash' }, { provider: 'raccoon', id: 'sn-pro' }] },
							{ id: 'deepseek', models: [] },
						],
						observed: ['raccoon/sn-flash'],
						models: ['ignored'],
						current: { provider: 'raccoon', model: 'sn-flash' },
						errors: [{ provider: 'slow', code: 'timeout' }],
						fetchedAt: 1762000000000,
					};
				},
			});
			const res = await callRoute(byPath.get(ROUTES.models), { url: ROUTES.models + '?session=s1' });
			assertEqual(res.status, 200);
			assertEqual(res.json.providers.length, 2);
			assertEqual(res.json.providers[0].name, 'Raccoon');
			assertEqual(res.json.providers[0].models.map((model) => model.id).join(','), 'sn-flash,sn-pro');
			assertEqual(res.json.providers[0].models[1].name, 'sn-pro', 'model name 空回退 id');
			assertEqual(res.json.providers[1].name, 'deepseek', 'provider name 空回退 id');
			assertEqual(res.json.observed.join(','), 'raccoon/sn-flash');
			assertEqual(res.json.models.join(','), res.json.observed.join(','), 'models 与 observed 同源');
			assertEqual(res.json.current.provider, 'raccoon');
			assertEqual(res.json.current.model, 'sn-flash');
			assertEqual(res.json.errors[0].code, 'timeout');
			assertEqual(res.json.fetchedAt, 1762000000000);
			assertEqual(seen[0].session, 's1', 'session 原样交给 catalog');
			assertEqual(seen[0].opts.refresh, false);
		},
	},
	{
		name: 'models：next 按本会话 pin 算下一次车道，current 仍是真实车道',
		async fn() {
			const { store, byPath } = await harness('routes-models-next', {
				modelCatalog: async () => ({
					providers: [{ id: 'raccoon', models: [] }, { id: 'deepseek', models: [] }],
					observed: ['raccoon/sn-flash'],
					current: { provider: 'raccoon', model: 'sn-flash' },
					errors: [],
					fetchedAt: 7,
				}),
			});
			const before = await callRoute(byPath.get(ROUTES.models), { url: ROUTES.models + '?session=s1' });
			assertEqual(before.json.next.provider, 'raccoon', '没 pin 时就是会话车道');
			assertEqual(before.json.next.model, 'sn-flash');
			assertEqual(before.json.lastApproval, null, '没有任何审批记录时 lastApproval 必须是 null');
			await store.writeSettings({ reviewerModel: 'deepseek/d-chat' });
			const global = await callRoute(byPath.get(ROUTES.models), { url: ROUTES.models + '?session=s1' });
			assertEqual(global.json.next.provider, 'deepseek', '全局 pin 生效');
			await store.writeSettings({ reviewerModelLocal: { s1: 'raccoon/sn-pro' } });
			const local = await callRoute(byPath.get(ROUTES.models), { url: ROUTES.models + '?session=s1' });
			assertEqual(local.json.next.provider, 'raccoon');
			assertEqual(local.json.next.model, 'sn-pro', '本会话 pin 盖过全局');
			assertEqual(local.json.current.model, 'sn-flash', 'current 仍是会话真实车道');
			await store.record(row({ id: 'm1', sessionId: 's1', routeModel: 'raccoon/sn-flash' }));
			const withRow = await callRoute(byPath.get(ROUTES.models), { url: ROUTES.models + '?session=s1' });
			assertEqual(withRow.json.lastApproval, 'raccoon/sn-flash', '上次审批来自台账行，不是会话车道');
			const other = await callRoute(byPath.get(ROUTES.models), { url: ROUTES.models + '?session=s2' });
			assertEqual(other.json.next.provider, 'deepseek', '别的会话不受此 pin 影响');
			await store.writeSettings({ reviewerModelLocal: { s1: '' } });
			const follow = await callRoute(byPath.get(ROUTES.models), { url: ROUTES.models + '?session=s1' });
			assertEqual(follow.json.next.model, 'sn-flash', '空串=跟随本会话车道，不是全局 pin');
		},
	},
	{
		name: 'config：reviewerModelLocal 能写能读，空串键保留',
		async fn() {
			const { byPath } = await harness('routes-config-local');
			const before = await callRoute(byPath.get(ROUTES.config), { url: ROUTES.config });
			assertEqual(JSON.stringify(before.json.reviewerModelLocal), '{}', '默认是空对象');
			const after = await callRoute(byPath.get(ROUTES.config), {
				method: 'POST',
				url: ROUTES.config,
				body: { reviewerModelLocal: { s1: 'raccoon/sn-flash', s2: '' } },
			});
			assertEqual(after.json.reviewerModelLocal.s1, 'raccoon/sn-flash');
			assertEqual(after.json.reviewerModelLocal.s2, '');
			assertTrue(Object.prototype.hasOwnProperty.call(after.json.reviewerModelLocal, 's2'), '键存在本身就是语义');
			const reread = await callRoute(byPath.get(ROUTES.config), { url: ROUTES.config });
			assertTrue(Object.prototype.hasOwnProperty.call(reread.json.reviewerModelLocal, 's2'), '读回来还在');
			assertEqual(reread.json.reviewerModelLocal.s1, 'raccoon/sn-flash');
		},
	},
	{
		name: 'models：?session= 与 ?refresh=1 交给 catalog，抛错也不 500',
		async fn() {
			const seen = [];
			const { byPath } = await harness('routes-models-refresh', {
				modelCatalog: async (session, opts) => {
					seen.push({ session, opts });
					return { providers: [], observed: ['raccoon/x'], current: null, errors: [], fetchedAt: 5 };
				},
			});
			const res = await callRoute(byPath.get(ROUTES.models), { url: ROUTES.models + '?session=s1&refresh=1' });
			assertEqual(res.status, 200);
			assertEqual(seen[0].session, 's1');
			assertEqual(seen[0].opts.refresh, true, 'refresh=1 变成布尔');
			assertEqual(res.json.observed.join(','), 'raccoon/x');
			const thrown = await harness('routes-models-throw', {
				modelCatalog: async () => {
					throw new Error('boom');
				},
			});
			const bad = await callRoute(thrown.byPath.get(ROUTES.models), { url: ROUTES.models });
			assertEqual(bad.status, 200, 'catalog 抛错也不 500');
			assertEqual(bad.json.providers.length, 0);
			assertEqual(bad.json.fetchedAt, 0);
		},
	},
];
