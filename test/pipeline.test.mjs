import { assertEqual, assertTrue, fakeCtx, freshRoot } from './helpers.mjs';
import { fingerprint } from '../src/store.js';

const HUMAN_WAIT_MS = 320;

/** A model stub: one reply, streamed. */
const replying = (text) => ({
	async *stream() {
		yield { text };
	},
});

async function boot(name, llm) {
	const { ctx, listeners } = fakeCtx();
	if (llm !== undefined) ctx.llm = llm;
	const mod = await import('../src/index.js');
	const root = await freshRoot(name);
	mod.apply(ctx, { root });
	await new Promise((resolve) => setTimeout(resolve, 30));
	const answer = mod.__internals.answerer;
	const store = mod.__internals.storeOf();
	return { mod, ctx, listeners, answer, store, root };
}

/** next() that behaves like the human prompt: resolves after HUMAN_WAIT_MS. */
const humanNext = (outcome = 'allowed-once', wait = HUMAN_WAIT_MS) => () => new Promise((resolve) => setTimeout(() => resolve(outcome), wait));

function request(toolName, callId, sessionId, extra = {}) {
	const events = [{ type: 'tool/call', data: { callId, name: toolName, arguments: JSON.stringify(extra.args ?? { command: 'npm test' }) } }];
	return Object.assign({ toolName, callId, reason: 'sandbox escalation', agent: { id: sessionId, session: { events } } }, extra.rest ?? {});
}

export const cases = [
	{
		name: '一次人工放行：decidedBy=human，且被记进记忆',
		async fn() {
			const { answer, store } = await boot('pipe-human');
			const req = request('ops_bash', 'c1', 's1');
			const outcome = await answer(req, humanNext());
			assertEqual(outcome, 'allowed-once');
			const rows = (await store.query({ session: 's1' })).entries;
			assertEqual(rows.length, 1);
			assertEqual(rows[0].decidedBy, 'human');
			const fp = fingerprint('ops_bash', JSON.stringify({ command: 'npm test' }));
			assertEqual((await store.memoryEntry('s1', fp)).count, 1);
		},
	},
	{
		name: '第三次人工放行后，第四次直接记忆通过（不调用 next）',
		async fn() {
			const { answer, store } = await boot('pipe-memory');
			for (let i = 0; i < 3; i += 1) {
				await answer(request('ops_bash', 'c' + i, 's1'), humanNext());
			}
			const fp = fingerprint('ops_bash', JSON.stringify({ command: 'npm test' }));
			assertEqual((await store.memoryEntry('s1', fp)).count, 3);
			let called = false;
			const spy = () => { called = true; return Promise.resolve('rejected'); };
			const outcome = await answer(request('ops_bash', 'c9', 's1'), spy);
			assertEqual(outcome, 'allowed-once', '记忆直接放行');
			assertEqual(called, false, '根本不用问人工');
			const rows = (await store.query({ session: 's1' })).entries;
			assertEqual(rows[0].decidedBy, 'memory');
			assertEqual(rows[0].memoryCount, 3);
			assertEqual((await store.memoryEntry('s1', fp)).count, 3, '记忆通过不再加计数');
		},
	},
	{
		name: '硬风险不进记忆：批三次也仍然转人工',
		async fn() {
			const { answer, store } = await boot('pipe-hardrisk');
			const risky = () => request('ops_bash', 'r' + Math.random(), 's1', { args: { command: 'rm -rf /d/Work/tmp' } });
			for (let i = 0; i < 3; i += 1) await answer(risky(), humanNext());
			let called = false;
			const spy = () => { called = true; return Promise.resolve('allowed-once'); };
			await answer(risky(), spy);
			assertEqual(called, true, '第 4 次仍然问人工');
			const rows = (await store.query({ session: 's1' })).entries;
			assertEqual(rows[0].riskLevel, 'high');
			assertEqual(rows[0].riskRule, 'delete');
			assertEqual((await store.memoryRows('s1')).length, 0, '一条记忆都没留下');
		},
	},
	{
		name: '会话隔离：别的会话同一操作仍然转人工',
		async fn() {
			const { answer, store } = await boot('pipe-session');
			for (let i = 0; i < 3; i += 1) await answer(request('ops_bash', 'c' + i, 's1'), humanNext());
			let called = false;
			const spy = () => new Promise((resolve) => setTimeout(() => { called = true; resolve('allowed-once'); }, HUMAN_WAIT_MS));
			await answer(request('ops_bash', 'x1', 's2'), spy);
			assertEqual(called, true, 's2 没有记忆，必须问人工');
			assertEqual((await store.memoryRows('s2')).length, 1, 's2 自己学到第 1 次');
			assertEqual((await store.memoryRows('s1')).length, 1);
		},
	},
	{
		name: '链路抛错：回落 unavailable，仍然记一行',
		async fn() {
			const { answer, store } = await boot('pipe-throw');
			const outcome = await answer(request('write', 'w1', 's1', { args: { file_path: 'D:/a.txt' } }), () => { throw new Error('boom'); });
			assertEqual(outcome, 'unavailable');
			const rows = (await store.query({ session: 's1' })).entries;
			assertEqual(rows.length, 1);
			assertEqual(rows[0].decidedBy, 'fallback');
			assertTrue(String(rows[0].note).indexOf('boom') > 0, '记下原因');
		},
	},
	{
		name: '瞬时应答被标成 external（别的 answerer 抢答）',
		async fn() {
			const { answer, store } = await boot('pipe-external');
			await answer(request('ops_bash', 'e1', 's1'), () => Promise.resolve('allowed-once'));
			const rows = (await store.query({ session: 's1' })).entries;
			assertEqual(rows[0].decidedBy, 'external');
			assertEqual((await store.memoryRows('s1')).length, 0, 'external 不教记忆');
		},
	},
	{
		name: 'AI 通过：reviewer 说 allow 时不问人工，归属记成 ai',
		async fn() {
			const { answer, store } = await boot('pipe-ai-allow', replying('{"decision":"allow","risk":"low","reason":"scoped rebuild"}'));
			let called = false;
			const spy = () => { called = true; return Promise.resolve('rejected'); };
			const outcome = await answer(request('ops_bash', 'a1', 's1'), spy);
			assertEqual(outcome, 'allowed-once');
			assertEqual(called, false, 'AI 放行就不用弹人工');
			const rows = (await store.query({ session: 's1' })).entries;
			assertEqual(rows[0].decidedBy, 'ai');
			assertEqual(rows[0].riskLevel, 'low');
			assertEqual(rows[0].aiSource, 'ai');
			assertTrue(String(rows[0].aiReason).indexOf('scoped') >= 0, '理由入账');
			assertEqual((await store.memoryRows('s1')).length, 0, 'AI 放行不教记忆');
		},
	},
	{
		name: 'AI 拿不准：转人工，人工批了才计数',
		async fn() {
			const { answer, store } = await boot('pipe-ai-ask', replying('{"decision":"ask","risk":"medium","reason":"unclear scope"}'));
			const outcome = await answer(request('ops_bash', 'a2', 's1'), humanNext());
			assertEqual(outcome, 'allowed-once');
			const rows = (await store.query({ session: 's1' })).entries;
			assertEqual(rows[0].decidedBy, 'human');
			assertEqual(rows[0].riskLevel, 'medium', 'AI 的风险判断仍然入账');
			assertEqual((await store.memoryRows('s1')).length, 1, '人工放行才教记忆');
		},
	},
	{
		name: '没有 llm 服务：直接转人工，链路不报错',
		async fn() {
			const { answer, store } = await boot('pipe-ai-none');
			const outcome = await answer(request('ops_bash', 'a3', 's1'), humanNext());
			assertEqual(outcome, 'allowed-once');
			const rows = (await store.query({ session: 's1' })).entries;
			assertEqual(rows[0].decidedBy, 'human');
		},
	},
	{
		name: 'AI 熔断：连续垃圾输出后退回人工，且不再调模型',
		async fn() {
			let calls = 0;
			const llm = {
				async *stream() {
					calls += 1;
					yield { text: '<tool_call name="x">' };
				},
			};
			const { answer, store } = await boot('pipe-ai-breaker', llm);
			// Distinct commands on purpose: one repeated operation would reach the memory
			// threshold first and never touch the reviewer at all (that layering is correct).
			const distinct = (i) => request('ops_bash', 'b' + i, 's1', { args: { command: 'npm test -- ' + i } });
			for (let i = 0; i < 3; i += 1) {
				await answer(distinct(i), humanNext());
			}
			const afterBreak = await answer(distinct(9), humanNext());
			assertEqual(afterBreak, 'allowed-once');
			assertEqual(calls, 3, '熔断后一次都不再调模型');
			const rows = (await store.query({ session: 's1' })).entries;
			assertEqual(rows[0].decidedBy, 'human', '熔断期间全部走人工');
			assertEqual(rows[0].aiSource, 'breaker');
		},
	},
	{
		name: '快照钩子挂在 tools/pre-execute 上，永远返回 next()',
		async fn() {
			const { listeners, mod } = await boot('pipe-hook');
			const hook = listeners.find((entry) => entry.event === 'tools/pre-execute');
			assertTrue(hook !== undefined, '钩子已注册');
			let called = false;
			const result = hook.listener(
				{ name: 'write', callId: 'h1', agent: { id: 's1' }, arguments: { file_path: 'D:/definitely/not/here.txt', content: 'x' } },
				() => { called = true; return 'NEXT'; },
			);
			assertEqual(result, 'NEXT', '必须原样返回 next()');
			assertEqual(called, true);
			const snapshot = mod.__internals.snapshotOf();
			assertTrue(snapshot !== undefined, '快照实例已装配');
			assertEqual(snapshot.has('s1', 'h1'), true, '写类调用留下了快照条目');
		},
	},
	{
		name: '硬风险连 AI 都不看：reviewer 一次都不调用',
		async fn() {
			let calls = 0;
			const llm = {
				async *stream() {
					calls += 1;
					yield { text: '{"decision":"allow","risk":"low"}' };
				},
			};
			const { answer, store } = await boot('pipe-ai-hardrisk', llm);
			await answer(request('ops_bash', 'h1', 's1', { args: { command: 'rm -rf /d/Work/tmp' } }), humanNext());
			assertEqual(calls, 0, '硬风险不送模型');
			const rows = (await store.query({ session: 's1' })).entries;
			assertEqual(rows[0].riskLevel, 'high');
			assertEqual(rows[0].riskRule, 'delete');
		},
	},
];
