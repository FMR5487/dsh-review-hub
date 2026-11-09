import { assertEqual, assertTrue } from './helpers.mjs';
import { parseVerdict, buildMessages, createReviewer } from '../src/review.js';

const settings = (over) => Object.assign({
	aiEnabled: true,
	reviewTimeoutMs: 1000,
	aiBudgetPerTurn: 20,
	aiBreakerFails: 3,
	aiCacheTtlMs: 600000,
}, over ?? {});

const replying = (text) => ({
	async *stream() {
		yield { type: 'text-delta', text };
	},
});

const unparsable = () => replying('<tool_call name="review">nope');

export const cases = [
	{
		name: 'parseVerdict：干净 JSON / 围栏 / 前后噪音',
		fn() {
			assertEqual(parseVerdict('{"decision":"allow","risk":"low","reason":"scoped"}').decision, 'allow');
			assertEqual(parseVerdict('\u0060\u0060\u0060json\n{"decision":"ask","risk":"high"}\n\u0060\u0060\u0060').decision, 'ask');
			assertEqual(parseVerdict('here you go: {"decision":"allow"} thanks').decision, 'allow');
			assertEqual(parseVerdict('{"decision":"ask","risk":"weird"}').risk, 'unknown', '非法风险值归一');
			assertEqual(parseVerdict('{"decision":"ALLOW"}').decision, 'allow', '大小写不敏感');
			assertEqual(parseVerdict('{"verdict":"allow"}').decision, 'allow', 'verdict 别名');
			// 严格模式：只认 {decision, risk, reason} 这一种形状，其余一律 unparsed
			assertEqual(parseVerdict('{"decision":"ALLOW","risk":"low"}', { strict: true }).decision, 'allow', '大小写不影响判定：严格只针对字段名与风险等级');
			assertEqual(parseVerdict('{"verdict":"allow","risk":"low"}', { strict: true }), undefined, '别名不合规');
			assertEqual(parseVerdict('{"decision":"allow"}', { strict: true }), undefined, '缺 risk 不合规');
			assertEqual(parseVerdict('{"decision":"allow","risk":"weird"}', { strict: true }), undefined, 'fake 风险等级不合规');
			assertEqual(parseVerdict('{"decision":"allow","risk":"low"}', { strict: true }).decision, 'allow', '规范形状通过');
			assertEqual(parseVerdict('{"decision":"deny","risk":"high","reason":"x"}', { strict: true }).decision, 'ask', '严格模式下 deny 仍然降级成 ask');
			assertEqual(parseVerdict('{"verdict":"allow","risk":"low"}').decision, 'allow', '宽松模式保持不变');
			assertEqual(parseVerdict('{"action":"approve"}').decision, 'allow', 'approve 也是 allow');
			assertEqual(parseVerdict('{"result":"escalate"}').decision, 'ask', 'escalate 也是 ask');
		},
	},
	{
		name: 'parseVerdict：垃圾输出与 deny 都不产生拒绝',
		fn() {
			assertEqual(parseVerdict('<tool_call name="x">'), undefined);
			assertEqual(parseVerdict('{"decision":"al'), undefined, '截断 JSON');
			assertEqual(parseVerdict(''), undefined);
			const denied = parseVerdict('{"decision":"deny","risk":"high","reason":"destructive"}');
			assertEqual(denied.decision, 'ask', 'reviewer 没有否决权：deny 只能是 ask');
			assertEqual(denied.reason, 'destructive', '否决的理由要留下来给人看');
			const downgraded = parseVerdict('{"decision":"ask","reason":"would deny"}');
			assertEqual(downgraded.decision, 'ask', '想拒绝只能变成转人工');
		},
	},
	{
		name: 'buildMessages：带工具/来源/摘要，且明令不得 deny',
		fn() {
			const prompt = buildMessages({ toolName: 'ops_bash', agentKind: 'subagent', reason: 'escalate', summary: 'npm test', priorApprovals: 2 });
			// The host llm seam takes system separately and content as blocks.
			assertTrue(prompt.system.indexOf('never deny') > 0, '系统提示写明没有否决权');
			assertEqual(prompt.messages.length, 1);
			assertEqual(prompt.messages[0].role, 'user');
			assertEqual(prompt.messages[0].content[0].type, 'text');
			const text = prompt.messages[0].content[0].text;
			assertTrue(text.indexOf('ops_bash') > 0);
			assertTrue(text.indexOf('subagent') > 0, '来源进入证据');
			assertTrue(text.indexOf('prior human approvals') > 0);
		},
	},
	{
		name: 'review：allow 走通，并记录来源',
		async fn() {
			const reviewer = createReviewer({ getLlm: () => replying('{"decision":"allow","risk":"low","reason":"scoped"}'), getSettings: () => settings() });
			const verdict = await reviewer.review({ sessionId: 's1', toolName: 'ops_bash' });
			assertEqual(verdict.decision, 'allow');
			assertEqual(verdict.risk, 'low');
			assertEqual(verdict.source, 'ai');
			assertEqual(reviewer.stats().allows, 1);
		},
	},
	{
		name: 'review：缓存命中不再调用模型',
		async fn() {
			let calls = 0;
			const reviewer = createReviewer({
				getLlm: () => ({
					async *stream() {
						calls += 1;
						yield { text: '{"decision":"allow","risk":"low"}' };
					},
				}),
				getSettings: () => settings(),
			});
			await reviewer.review({ sessionId: 's1', toolName: 'ops_bash', cacheKey: 'fp1' });
			const second = await reviewer.review({ sessionId: 's1', toolName: 'ops_bash', cacheKey: 'fp1' });
			assertEqual(calls, 1);
			assertEqual(second.source, 'cache');
		},
	},
	{
		name: 'review：解析失败 → ask，连续 3 次熔断后不再调用',
		async fn() {
			let calls = 0;
			const reviewer = createReviewer({
				getLlm: () => ({
					async *stream() {
						calls += 1;
						yield { text: 'not json at all' };
					},
				}),
				getSettings: () => settings(),
			});
			for (let i = 0; i < 3; i += 1) {
				const verdict = await reviewer.review({ sessionId: 's1', toolName: 'ops_bash' });
				assertEqual(verdict.decision, 'ask', '永不 deny');
				assertEqual(verdict.source, 'unparsed');
			}
			const open = await reviewer.review({ sessionId: 's1', toolName: 'ops_bash' });
			assertEqual(open.source, 'breaker');
			assertEqual(calls, 3, '熔断后一次都不再调模型');
			reviewer.reset('s1');
			assertEqual((await reviewer.review({ sessionId: 's1', toolName: 'ops_bash' })).source, 'unparsed', '手动复位后恢复');
		},
	},
	{
		name: 'review：超时 → ask（不阻塞审批链）',
		async fn() {
			const reviewer = createReviewer({
				getLlm: () => ({
					stream: ({ signal }) => new Promise((_resolve, reject) => {
						signal.addEventListener('abort', () => reject(new Error('aborted')));
					}),
				}),
				getSettings: () => settings({ reviewTimeoutMs: 1000 }),
			});
			const started = Date.now();
			const verdict = await reviewer.review({ sessionId: 's1', toolName: 'ops_bash' });
			assertEqual(verdict.decision, 'ask');
			assertTrue(Date.now() - started < 4000, '在超时预算内返回');
		},
	},
	{
		name: 'review：预算与开关',
		async fn() {
			let calls = 0;
			const llm = () => ({
				async *stream() {
					calls += 1;
					yield { text: '{"decision":"ask"}' };
				},
			});
			const capped = createReviewer({ getLlm: llm, getSettings: () => settings({ aiBudgetPerTurn: 1 }) });
			await capped.review({ sessionId: 's2', toolName: 'ops_bash' });
			const second = await capped.review({ sessionId: 's2', toolName: 'ops_bash' });
			assertEqual(second.source, 'budget');
			assertEqual(calls, 1);
			const off = createReviewer({ getLlm: llm, getSettings: () => settings({ aiEnabled: false }) });
			assertEqual((await off.review({ sessionId: 's3', toolName: 'ops_bash' })).source, 'disabled');
			const none = createReviewer({ getLlm: () => undefined, getSettings: () => settings() });
			assertEqual((await none.review({ sessionId: 's4', toolName: 'ops_bash' })).source, 'unavailable');
		},
	},
];
