import { assertEqual, assertTrue } from './helpers.mjs';
import { createCatalog } from '../src/catalog.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A provider list plus per-id model lists. */
const stub = (providers, listModels) => ({
	listProviders: () => providers,
	listModels,
});

export const cases = [
	{
		name: 'catalog: 聚合 provider 与 model，name 空回退 id',
		async fn() {
			let calls = 0;
			const llm = stub(
				[{ id: 'raccoon', name: 'Raccoon' }, { id: 'deepseek' }],
				async (id) => {
					calls += 1;
					if (id === 'raccoon') {
						return [
							{ provider: 'raccoon', id: 'sn-flash', name: 'Flash' },
							{ provider: 'raccoon', id: 'sn-pro', name: '' },
						];
					}
					return [{ provider: 'deepseek', id: 'v4', name: 'V4' }];
				},
			);
			const catalog = createCatalog({
				getLlm: () => llm,
				observed: () => ['raccoon/sn-flash'],
				currentOf: (session) => (session === 's1' ? { provider: 'raccoon', model: 'sn-flash' } : undefined),
			});
			const snap = await catalog.snapshot({ session: 's1' });
			assertEqual(calls, 2, '每个 provider 各调一次 listModels');
			assertEqual(snap.providers.length, 2);
			assertEqual(snap.providers[0].id, 'raccoon');
			assertEqual(snap.providers[0].name, 'Raccoon');
			assertEqual(snap.providers[0].models.map((model) => model.id).join(','), 'sn-flash,sn-pro');
			assertEqual(snap.providers[0].models[0].name, 'Flash');
			assertEqual(snap.providers[0].models[1].name, 'sn-pro', 'name 空回退 id');
			assertEqual(snap.providers[1].name, 'deepseek', 'provider name 空回退 id');
			assertEqual(snap.observed.join(','), 'raccoon/sn-flash');
			assertEqual(snap.models.join(','), snap.observed.join(','), 'models 是 observed 的别名');
			assertEqual(snap.current.provider, 'raccoon');
			assertEqual(snap.errors.length, 0);
			assertTrue(snap.fetchedAt > 0, 'fetchedAt 有值');
		},
	},
	{
		name: 'catalog: 单个 provider 抛错只让它 models=[]，其它照常',
		async fn() {
			const llm = stub(
				[{ id: 'bad' }, { id: 'sync-bad' }, { id: 'good' }],
				async (id) => {
					if (id === 'bad') throw new Error('boom');
					if (id === 'sync-bad') throw new Error('boom-sync');
					return [{ id: 'm1', name: 'M1' }];
				},
			);
			const catalog = createCatalog({ getLlm: () => llm, observed: () => [], currentOf: () => undefined });
			const snap = await catalog.snapshot();
			assertEqual(snap.providers.length, 3, '失败的 provider 仍然在名单里');
			assertEqual(snap.providers[0].models.length, 0);
			assertEqual(snap.providers[2].models.map((model) => model.id).join(','), 'm1', '好的 provider 不受影响');
			assertEqual(snap.errors.map((error) => error.provider + ':' + error.code).join(','), 'bad:throw,sync-bad:throw');
		},
	},
	{
		name: 'catalog: 超时的 provider 记 timeout，且迟到的 rejection 不外溢',
		async fn() {
			const llm = stub(
				[{ id: 'slow' }, { id: 'fast' }],
				(id) => (id === 'slow'
					// Rejects AFTER the race is lost: an uncaught arm here would crash the host.
					? new Promise((_resolve, reject) => setTimeout(() => reject(new Error('late')), 40))
					: Promise.resolve([{ id: 'm1', name: 'M1' }])),
			);
			const catalog = createCatalog({ getLlm: () => llm, providerTimeoutMs: 20, observed: () => [], currentOf: () => undefined });
			const snap = await catalog.snapshot();
			assertEqual(snap.errors.map((error) => error.provider + ':' + error.code).join(','), 'slow:timeout');
			assertEqual(snap.providers[0].models.length, 0);
			assertEqual(snap.providers[1].models.length, 1);
			await sleep(60);
		},
	},
	{
		name: 'catalog: 没有 llm 服务 / getLlm 抛错都是空目录而不是异常',
		async fn() {
			const none = createCatalog({ getLlm: () => undefined, observed: () => ['a/b'], currentOf: () => undefined });
			const empty = await none.snapshot();
			assertEqual(empty.providers.length, 0);
			assertEqual(empty.errors.length, 1);
			assertEqual(empty.errors[0].code, 'unavailable');
			assertEqual(empty.observed.join(','), 'a/b', '没有目录也回报已知车道');
			assertEqual(empty.current, null, '当前路由未知为 null');
			const throwing = createCatalog({ getLlm: () => { throw new Error('no service'); }, observed: () => [], currentOf: () => undefined });
			const snap = await throwing.snapshot();
			assertEqual(snap.providers.length, 0);
			assertEqual(snap.errors[0].code, 'unavailable');
		},
	},
	{
		name: 'catalog: TTL 内不重复取，refresh 绕过并刷新 fetchedAt',
		async fn() {
			let calls = 0;
			const llm = stub([{ id: 'p1' }], async () => {
				calls += 1;
				return [{ id: 'm1', name: 'M1' }];
			});
			const catalog = createCatalog({ getLlm: () => llm, ttlMs: 60000, observed: () => [], currentOf: () => undefined });
			const first = await catalog.snapshot();
			const second = await catalog.snapshot();
			assertEqual(calls, 1, 'TTL 内不重复调 listProviders/listModels');
			assertEqual(first.fetchedAt, second.fetchedAt, '缓存命中不改 fetchedAt');
			await sleep(2);
			const forced = await catalog.snapshot({ refresh: true });
			assertEqual(calls, 2, 'refresh 绕过缓存');
			assertTrue(forced.fetchedAt >= first.fetchedAt, '刷新后 fetchedAt 前进');
		},
	},
	{
		name: 'catalog: observed 与 current 每次重算（不受 TTL 影响）',
		async fn() {
			let calls = 0;
			let lanes = ['a/one'];
			let current;
			const llm = stub([{ id: 'a' }], async () => {
				calls += 1;
				return [{ id: 'one', name: 'One' }];
			});
			const catalog = createCatalog({
				getLlm: () => llm,
				observed: () => lanes,
				currentOf: () => current,
			});
			const first = await catalog.snapshot({ session: 's1' });
			assertEqual(first.observed.join(','), 'a/one');
			assertEqual(first.current, null);
			lanes = ['a/one', 'b/two'];
			current = { provider: 'b', model: 'two' };
			const second = await catalog.snapshot({ session: 's1' });
			assertEqual(calls, 1, 'provider 目录仍然走缓存');
			assertEqual(second.observed.join(','), 'a/one,b/two', 'observed 每轮重算');
			assertEqual(second.models.join(','), 'a/one,b/two');
			assertEqual(second.current.provider, 'b');
			assertEqual(second.current.model, 'two');
		},
	},
	{
		name: 'catalog: listProviders 抛错 → 空 providers 加一条 unavailable，不抛给调用方',
		async fn() {
			const llm = {
				listProviders: () => { throw new Error('catalog down'); },
				listModels: async () => [{ id: 'm1' }],
			};
			const catalog = createCatalog({ getLlm: () => llm, observed: () => [], currentOf: () => undefined });
			const snap = await catalog.snapshot();
			assertEqual(snap.providers.length, 0);
			assertEqual(snap.errors.length, 1);
			assertEqual(snap.errors[0].provider, '');
			assertEqual(snap.errors[0].code, 'unavailable');
			const rejecting = createCatalog({
				getLlm: () => ({ listProviders: async () => { throw new Error('catalog down'); } }),
				observed: () => [],
				currentOf: () => undefined,
			});
			const second = await rejecting.snapshot();
			assertEqual(second.providers.length, 0);
			assertEqual(second.errors[0].code, 'unavailable', 'reject 同样兜住');
		},
	},
];
