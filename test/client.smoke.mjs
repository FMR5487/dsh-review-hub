import { readFileSync } from 'node:fs';
import { assertEqual, assertTrue } from './helpers.mjs';
import { KNOB_KEYS } from '../src/store.js';

const REACT_STUB = {
	createElement: function (type, props) {
		// Children are kept: without them a rendered tree stops at its first level and no test
		// can assert that a nested control (e.g. the row's AI picker) really rendered.
		const kids = Array.prototype.slice.call(arguments, 2);
		const merged = Object.assign({}, props || {});
		if (kids.length === 1) merged.children = kids[0];
		else if (kids.length > 1) merged.children = kids;
		return { type: type, props: merged };
	},
	useState: function (initial) { return [typeof initial === 'function' ? initial() : initial, function () {}]; },
	useEffect: function () {},
	useMemo: function (factory) { return factory(); },
	useRef: function (value) { return { current: value }; },
	Fragment: 'fragment',
};

const requireStub = function (name) {
	if (name === 'react') return REACT_STUB;
	throw new Error('unexpected require: ' + name);
};

function node(tag) {
	return {
		tag: tag,
		textContent: '',
		style: {},
		children: [],
		attrs: {},
		setAttribute: function (name, value) { this.attrs[name] = value; },
		appendChild: function (child) { this.children.push(child); return child; },
		remove: function () {},
		click: function () {},
	};
}

function makeDocument() {
	const styleNodes = [];
	const doc = {
		baseURI: 'http://127.0.0.1:1234/',
		head: { appendChild: function (el) { styleNodes.push(el); } },
		body: { appendChild: function () {} },
		createElement: node,
		addEventListener: function () {},
		hidden: false,
	};
	return { doc: doc, styleNodes: styleNodes };
}

/** The client module registers itself through the loader once; reuse that definition. */
let definition;
async function loadDefinition() {
	if (definition !== undefined) return definition;
	const savedWindow = globalThis.window;
	const savedDocument = globalThis.document;
	const scratch = makeDocument();
	globalThis.document = scratch.doc;
	globalThis.window = { __ModuleLoader__: { load: function (value) { definition = value; } } };
	try {
		await import('../src/client.js?smoke');
	} finally {
		globalThis.window = savedWindow;
		globalThis.document = savedDocument;
	}
	return definition;
}

function makeCtx(seats, locales, effects) {
	return {
		slots: {
			inject: function (_name, callback) { callback(); },
			register: function (config, component) { seats.push({ config: config, component: component }); return function () {}; },
		},
		locale: { register: function (namespace, dictionary) { locales.push({ namespace: namespace, dictionary: dictionary }); } },
		effect: function (factory, label) {
			effects.push(label);
			const off = factory();
			return function () { if (typeof off === 'function') off(); };
		},
	};
}

async function withDocument(fn) {
	const savedDocument = globalThis.document;
	const scratch = makeDocument();
	globalThis.document = scratch.doc;
	try {
		return await fn(scratch);
	} finally {
		globalThis.document = savedDocument;
	}
}

export const cases = [
	{
		name: '模块形态：loader id、唯一 require(react)、inject 列表',
		async fn() {
			const def = await loadDefinition();
			assertEqual(def.id, 'dsh-review-hub', 'loader id 必须等于包名');
			const mod = def.factory(requireStub);
			assertEqual(JSON.stringify(mod.inject), '["slots","locale"]');
			assertEqual(typeof mod.apply, 'function');
		},
	},
	{
		name: '三个席位：输入框提示、配置卡、对话顶部「审批」标签',
		async fn() {
			const def = await loadDefinition();
			await withDocument(async function () {
				const seats = [];
				const locales = [];
				const effects = [];
				const mod = def.factory(requireStub);
				mod.apply(makeCtx(seats, locales, effects));
				assertEqual(seats.length, 3, 'dock + config + view（注册 conversation.approval.detail 子席位会让 web boot 起不来，已回退）');
				assertEqual(seats[0].config.name, 'conversation.input.dock', '必须是输入框上方那一行（composer.dock 在输入框盒子内部的下方）');
				assertEqual(seats[0].config.order, 30, '排在宿主自己的 todo(0)/queue(20) 之下');
				assertEqual(seats[1].config.name, 'plugins.bundle.config');
				assertEqual(seats[2].config.name, 'conversation.view');
				assertEqual(seats[2].config.id, 'review-hub.view');
				assertEqual(seats[2].config.order, 20);
				assertEqual(seats[2].config.label, '审批', '未读为 0 时标签就是「审批」');
				assertEqual(typeof seats[2].config.inject, 'function');
				assertEqual(seats[2].config.inject('s1').sessionId, 's1');
				assertEqual(typeof seats[0].config.inject, 'function', 'dock 必须拿到会话 id，否则只能看全局流');
				assertEqual(seats[0].config.inject('s9').sessionId, 's9');
			});
		},
	},
	{
		name: '文案：zh/en 键数一致，且关键文案符合约定',
		async fn() {
			const def = await loadDefinition();
			await withDocument(async function () {
				const seats = [];
				const locales = [];
				const effects = [];
				const mod = def.factory(requireStub);
				mod.apply(makeCtx(seats, locales, effects));
				assertEqual(locales.length, 1);
				assertEqual(locales[0].namespace, 'dsh-review-hub');
				const zh = locales[0].dictionary.zh;
				const en = locales[0].dictionary.en;
				assertEqual(Object.keys(zh).length, Object.keys(en).length, 'zh/en 必须成对');
				assertEqual(zh['tab'], '审批');
				assertEqual(zh['bar.search'], '查找', '搜索图标换成文字');
				assertEqual(zh['memory.progress'], '记忆 {count}/{threshold} 次');
				assertEqual(zh['chip.memory'], '记忆通过');
				assertEqual(zh['chip.ai'], 'AI 通过');
				assertEqual(zh['chip.human'], '人工通过');
				assertEqual(zh['memory.clear'], '清空记忆');
				assertEqual(zh['setting.clear'], '清空历史（仅当前会话）');
				assertTrue(zh['setting.clearOn'] !== undefined);
				assertTrue(JSON.stringify(zh).indexOf('已关闭') === -1, '设置里不再有那句提示');
				assertTrue(JSON.stringify(zh).indexOf('⌕') === -1, '不再使用搜索图标');
			});
		},
	},
	{
		name: '样式只注入一次，且带 composer 提示与筛选行',
		async fn() {
			const def = await loadDefinition();
			await withDocument(async function (scratch) {
				const seats = [];
				const locales = [];
				const effects = [];
				const mod = def.factory(requireStub);
				mod.apply(makeCtx(seats, locales, effects));
				assertEqual(scratch.styleNodes.length, 1);
				const css = scratch.styleNodes[0].textContent;
				assertTrue(css.indexOf('.ah-card-ai') > 0, '有 AI 提示卡样式');
				assertTrue(css.indexOf('.ah-card-memory') > 0, '有记忆提示卡样式');
				assertTrue(css.indexOf('.ah-time') > 0, '日期输入有样式');
				assertTrue(css.indexOf('border-radius:8px') > 0, '日期输入圆角');
				assertTrue(css.indexOf('.ah-chip-pre{color:inherit') > 0, '「AI 打回」前缀跟随所在条目的配色');
			});
		},
	},
	{
		name: '缺 slots 时只报错一次且不抛',
		async fn() {
			const def = await loadDefinition();
			await withDocument(async function () {
				const errors = [];
				const original = console.error;
				console.error = function () { errors.push([].slice.call(arguments).join(' ')); };
				try {
					const mod = def.factory(requireStub);
					mod.apply({ locale: { register: function () {} }, effect: function (factory) { factory(); } });
					assertEqual(errors.length, 1, '一次报告，不抛');
				} finally {
					console.error = original;
				}
			});
		},
	},
	{
		name: '撤销要连点两次：一次只上膛，3 秒不点就放弃',
		async fn() {
			const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');
			assertTrue(src.indexOf('const REVERT_CONFIRM_MS = 3000;') > 0, '上膛窗口是 3 秒');
			assertTrue(src.indexOf('function armRevert(callId)') > 0, '按钮走上膛函数');
			assertTrue(src.indexOf('onClick: function () { armRevert(state.callId); }') > 0, '一次点击不直接投递撤销');
			assertTrue(src.indexOf('void revertDiff(state.callId)') === -1, '撤销不能再由单击触发');
			assertTrue(src.indexOf("store.revertArmed === callId") > 0, '第二次点击才执行');
			assertTrue(src.indexOf('revertArmTimer = setTimeout') > 0, '停手后自己放弃');
			assertTrue(src.indexOf("t('diff.revertConfirm')") > 0, '上膛后按钮换成确认文案');
		},
	},
	{
		name: '卡片生命周期：基线、未读口径、分割线、三档时长',
		async fn() {
			const def = await loadDefinition();
			const mod = def.factory(requireStub);
			const bag = mod.__test;
			assertTrue(bag !== undefined, '__test 必须暴露纯函数');
			const rows = [
				{ id: 'a', ts: 300, decidedBy: 'ai' },
				{ id: 'b', ts: 200, decidedBy: 'memory' },
				{ id: 'e', ts: 150, decidedBy: 'external' },
				{ id: 'c', ts: 100, decidedBy: 'human' },
				{ id: 'd', ts: 50, decidedBy: 'fallback' },
			];
			// 基线：floor 之内一律不出卡，人工永不出卡
			assertEqual(bag.shouldHint(rows[0], 200, new Set()), true, '基线之后的新行可以出卡');
			assertEqual(bag.shouldHint(rows[1], 200, new Set()), false, '基线之内是历史');
			assertEqual(bag.shouldHint(rows[2], 0, new Set()), false, '人工决策不走提示卡');
			assertEqual(bag.shouldHint(rows[0], 0, new Set(['a'])), false, '已经出过的卡不再出');
			// 未读口径：ai/memory/external 计入，human/fallback 不计
			assertEqual(bag.unreadCount(rows, 0), 3, 'ai + memory + external');
			assertEqual(bag.unreadCount(rows, 250), 1, '只看 seenAt 之后');
			// 分割线：第一条"已看过"的位置
			assertEqual(bag.dividerAt(rows, 250), 1);
			assertEqual(bag.dividerAt(rows, 0), -1, '从没看过就没有分割线');
			assertEqual(bag.dividerAt([{ id: 'x', ts: 10, decidedBy: 'ai' }], 999), 0);
			// 三档时长默认值
			assertEqual(bag.hintMsOf('ai'), 30000);
			assertEqual(bag.hintMsOf('memory'), 8000);
			assertEqual(bag.hintMsOf('pending'), 0, '人工卡一直留到决策');
			// 倒计时环：起始相位靠负延时对齐已经过去的时长，超出总时长就夹住
			assertEqual(bag.ringTiming(30000, 5000).durationMs, 30000);
			assertEqual(bag.ringTiming(30000, 5000).delayMs, -5000);
			assertEqual(bag.ringTiming(8000, 99999).delayMs, -8000, '不许超前');
			assertEqual(bag.ringTiming(0, 0).durationMs, 1, '至少 1ms，避免除零');
			assertEqual(bag.countdownRing(8000, 0).props.className, 'ah-ring');
			// 徽标 chip 用自己的颜色，高危走 danger
			assertEqual(bag.cardChipClass('memory', false), 'ah-card-chip ah-card-chip-memory');
			assertEqual(bag.cardChipClass('pending', true), 'ah-card-chip ah-card-chip-danger');
			assertEqual(bag.cardChipClass(undefined, false), 'ah-card-chip ah-card-chip-other');
			// 浏览器半身抄了一份旋钮键表（bundle 无法 import 服务端），两份必须一致：
			// 服务端靠它合并指纹、客户端靠它隐藏显示，任何一方漏掉新键都会表现为「合并了但没隐藏」。
			assertEqual(
				JSON.stringify([...bag.knobKeys].sort()),
				JSON.stringify([...KNOB_KEYS].sort()),
				'client 与 store 的 KNOB_KEYS 必须相同',
			);
			// 高级设置卡片必须能真的渲染出来。曾经它借用了兄弟组件里的 numRow，作用域外
			// 引用 → 整张卡抛异常 → 插件页「高级设置全部不见了」，而当时所有测试都是绿的。
			const card = bag.configCard({ locale: 'zh', debugDraft: {} });
			assertTrue(card !== null && card !== undefined, '高级设置卡片能渲染');
			// 窄栏分组隐藏：倍率 → 提供商 → 模型后缀
			const parts = bag.laneParts('Qoder/Qwen3.8-Flash · x0.00');
			assertEqual(parts.provider, 'Qoder/');
			assertEqual(parts.model, 'Qwen3.8-Flash');
			assertEqual(parts.price, ' · x0.00');
			assertEqual(parts.short, 'Qwen3.8', '先丢 -Flash 这种限定词');
			// AI 打回：评审看过但裁决是 ask（decidedBy 不是 ai，且记了 aiSource）
			assertEqual(bag.aiEscalated({ decidedBy: 'human', aiSource: 'ai' }), true);
			assertEqual(bag.aiEscalated({ decidedBy: 'human', aiSource: 'cache' }), true);
			assertEqual(bag.aiEscalated({ decidedBy: 'ai', aiSource: 'ai' }), false, 'AI 自己放行不算打回');
			assertEqual(bag.aiEscalated({ decidedBy: 'human' }), false, '没被审过的人工作业');
			assertEqual(bag.aiEscalated({ decidedBy: 'memory', aiSource: 'ai' }), false, '记忆在 AI 之前，不可能既是记忆又被 AI 打回');
			// 展开描述：AI 打回的条目两块都留（调用方的说法 + 评审自己的理由），其余一块
			const two = bag.reasonBlockOf({ decidedBy: 'human', aiSource: 'ai', reason: 'escalate sandbox', aiReason: '脚本来自临时目录未经审核' });
			assertEqual(two.own, 'escalate sandbox', '调用方的说法不能被 AI 的理由顶掉');
			assertEqual(two.ai, '脚本来自临时目录未经审核', 'AI 打回理由要显示');
			assertEqual(bag.reasonBlockOf({ decidedBy: 'human', aiSource: 'ai', reason: 'same', aiReason: 'same' }).ai, '', '两块同文不重复');
			assertEqual(bag.reasonBlockOf({ decidedBy: 'human', reason: 'manual note' }).ai, '', '没被 AI 看过就没有 AI 理由');
			const allowed = bag.reasonBlockOf({ decidedBy: 'ai', aiSource: 'ai', reason: 'escalate sandbox', aiReason: 'looks safe' });
			assertEqual(allowed.own, 'escalate sandbox', 'AI 放行的行也要保留调用方的描述');
			assertEqual(allowed.ai, 'looks safe', '放行理由单独一段');
			assertEqual(allowed.label, 'row.aiAllow', '放行与打回用不同标签');
			assertEqual(bag.reasonBlockOf({ decidedBy: 'human', aiSource: 'ai', reason: 'a', aiReason: 'b' }).label, 'row.aiReject');
			assertEqual(bag.reasonBlockOf({ decidedBy: 'memory', reason: 'only mine' }).label, '', '没有评审那段就没有标签');
			// 风险等级跟着评审那段走：aiRisk 优先，回落到行的 riskLevel
			assertEqual(bag.reasonBlockOf({ decidedBy: 'human', aiSource: 'ai', reason: 'a', aiReason: 'b', riskLevel: 'medium' }).risk, 'medium');
			assertEqual(bag.reasonBlockOf({ decidedBy: 'human', aiSource: 'ai', reason: 'a', aiReason: 'b', aiRisk: 'high', riskLevel: 'low' }).risk, 'high', 'aiRisk 优先');
			assertEqual(bag.reasonBlockOf({ decidedBy: 'memory', reason: 'a', riskLevel: 'high' }).risk, '', '没有评审那段就不显示风险');
			assertEqual(bag.riskLabel('medium', (k) => k), 'risk.medium');
			assertEqual(bag.riskLabel('weird', (k) => k), 'weird', '不认识的等级原样显示');
			// 徽章拆组：同类合并、AI 打回、记忆句各自成组（窄栏可整组隐藏）
			// 合并是「记忆 n/N 次」的前缀，不再单独成一个徽章
			assertEqual(bag.isMerged({ fpMode: 'normalized', droppedKeys: ['limit'], memoryCount: 1 }), false, '第一次出现时还什么都没合并');
			assertEqual(bag.isMerged({ fpMode: 'normalized', droppedKeys: ['limit'], memoryCount: 2 }), true);
			assertEqual(bag.isMerged({ memoryCount: 3 }), false, '没剥旋钮就不算合并');
			const mergedText = bag.memoryText({ memoryCount: 3, fpMode: 'normalized', droppedKeys: ['limit'] }, (k) => k);
			assertEqual(mergedText.parts.pre, 'memory.mergedPrefix', '「合并」是记忆句前面单独的一段，窄栏先丢它');
			assertEqual(mergedText.parts.lead, 'memory.progressLead');
			assertEqual(mergedText.parts.frac, '3/3');
			const plainText = bag.memoryText({ memoryCount: 1, fpMode: 'normalized', droppedKeys: ['limit'] }, (k) => k);
			assertEqual(plainText.parts.pre, '', '第一次不写合并');
			// 记忆句拆成三段，窄栏只丢「次」这一小段
			assertEqual(plainText.parts.unit, 'memory.progressUnit');
			const memoryChip = bag.chipOf({ decidedBy: 'memory', outcome: 'allowed-once' }, (k) => k);
			assertEqual(memoryChip.text, 'chip.memory');
			// 文件行：达到阈值就算「已满」（那一刻起单文件开关能自动放行）；非文件行仍显示 n/N
			const savedFiles = bag.store.files;
			const savedCfg = bag.store.config;
			bag.store.config = null;
			bag.store.files = [{ path: 'D:/x/a.md', count: 3 }];
			const fileFull = bag.memoryText({ id: 'f1', ts: 10, filePath: 'D:/x/a.md', memoryCount: 3, decidedBy: 'human' }, (k) => k);
			assertEqual(fileFull.long, 'memory.full · memory.canArm', '文件行 3/3 直接说已满');
			bag.store.files = [{ path: 'D:/x/a.md', count: 2 }];
			const fileTwo = bag.memoryText({ id: 'f2', ts: 11, filePath: 'D:/x/a.md', memoryCount: 2, decidedBy: 'human' }, (k) => k);
			assertEqual(fileTwo.parts.frac, '2/3', '没满的文件行仍给分数');
			const nonFile = bag.memoryText({ memoryCount: 3, decidedBy: 'human' }, (k) => k);
			assertEqual(nonFile.parts.frac, '3/3', '非文件行到达阈值仍显示 n/N');
			bag.store.files = savedFiles;
			// 「加入 AI 预审」图标的三态：只对未知工具出现，阈值按台账跨会话的人工通过数算
			bag.store.config = { aiTools: [], threshold: 3 };
			bag.store.byTool = { weird_tool: { total: 4, approved: 1, rejected: 1 } };
			const dim = bag.aiPickerOf({ toolName: 'weird_tool', unknownTool: true });
			assertEqual(dim.state, 'dim');
			assertEqual(dim.need, 2, '还差几次要算出来给 tooltip');
			bag.store.byTool = { weird_tool: { total: 4, approved: 3, rejected: 0 } };
			assertEqual(bag.aiPickerOf({ toolName: 'weird_tool', unknownTool: true }).state, 'ready', '人批到阈值就亮');
			bag.store.config = { aiTools: ['weird_tool'], threshold: 3 };
			assertEqual(bag.aiPickerOf({ toolName: 'weird_tool', unknownTool: true }).state, 'on', '已在名单里点亮');
			assertEqual(bag.aiPickerOf({ toolName: 'weird_tool' }), null, '已知工具不出图标');
			// 卡片座位：未交权留在提示卡（渲染层管），交权后才归浮层
			const none = new Set();
			const seatRows = [
				{ id: 'a', aiReviewed: false, humanAsked: false },
				{ id: 'b', aiReviewed: false, humanAsked: true },
				{ id: 'c', humanAsked: true, riskLevel: 'high', aiSkip: 'hard-risk:delete' },
				{ id: 'd', humanAsked: true, aiSkip: 'coarse-key:command' },
				{ id: 'e', humanAsked: true, decidedBy: 'human' },
			];
			assertEqual(bag.floatCandidateOf([seatRows[0]], '', none), undefined, '没交权就先留在提示卡');
			assertEqual(bag.floatCandidateOf(seatRows, '', none).id, 'b', '交权后的未决行归浮层');
			assertEqual(bag.floatCandidateOf([seatRows[2]], '', none).id, 'c', 'L0 高危必须出卡（以前被 aiSkip 吃掉）');
			assertEqual(bag.floatCandidateOf([seatRows[3]], '', none), undefined, 'D 粗筛暂时不出卡');
			assertEqual(bag.floatCandidateOf([seatRows[4]], '', none), undefined, '已决的行没有卡');
			assertEqual(bag.floatCandidateOf([{ id: 'x', humanAsked: true, sessionId: 'session-b' }], 'session-a', none), undefined, '别的会话不抢这个座位');
			assertEqual(bag.floatCandidateOf([{ id: 'y', humanAsked: true }], 'session-a', none).id, 'y', '没有 sessionId 的老行算本会话');
			assertEqual(bag.floatCandidateOf([{ id: 'x', humanAsked: true }], '', new Set(['x'])), undefined, '关掉的卡不再回来');
			// AI 返回时间的显示口径：短用 ms，长用 s
			assertEqual(bag.formatMs(840), '840ms');
			assertEqual(bag.formatMs(1200), '1.2s');
			assertEqual(bag.formatMs(65200), '65s');
			assertEqual(bag.formatMs(undefined), '—');
			assertEqual(bag.formatMs(-1), '—');
			// 行渲染：未知工具那一行必须真的挂出图标按钮（灰色 = disabled）
			const pickerOpts = { t: (k) => k, view: { diff: null }, copiedId: '', isReasonOpen: function () { return false; }, openDiff: function () {}, copyRow: function () {}, toggleReason: function () {} };
			const collectClass = function (node, out) {
				if (node === null || typeof node !== 'object') return out;
				const props = node.props || {};
				if (typeof props.className === 'string' && props.className.indexOf('ah-ai-pick') >= 0) out.push({ className: props.className, disabled: props.disabled === true, title: props.title });
				const kids = props.children;
				const list = Array.isArray(kids) ? kids : (kids === undefined || kids === null ? [] : [kids]);
				for (const kid of list) collectClass(kid, out);
				return out;
			};
			bag.store.byTool = {};
			bag.store.config = { threshold: 3, aiTools: [] };
			const unknownRow = bag.approvalRowNode({ id: 'u1', ts: 20, toolName: 'weird_tool', unknownTool: true, decidedBy: 'human', outcome: 'allowed-once', argsText: '{"foo":1}' }, pickerOpts);
			const unknownButtons = collectClass(unknownRow, []);
			assertEqual(unknownButtons.length, 1, '未知工具的行上要有一枚 AI 图标');
			assertEqual(unknownButtons[0].disabled, true, '没批够次数时不可点');
			assertTrue(String(unknownButtons[0].className).indexOf('ah-ai-dim') >= 0, '灰色态用 ah-ai-dim');
			assertTrue(String(unknownButtons[0].title).indexOf('row.aiHint') >= 0, 'tooltip 带「也可在设置里手动填写」');
			const knownRow = bag.approvalRowNode({ id: 'k1', ts: 21, toolName: 'pwsh', unknownTool: false, decidedBy: 'human', outcome: 'allowed-once', argsText: '{"command":"echo hi"}' }, pickerOpts);
			assertEqual(collectClass(knownRow, []).length, 0, '已知工具的行不该出现这枚图标');
			assertEqual(bag.aiPickerOf({ toolName: 'weird_tool', unknownTool: false }), null);
			bag.store.byTool = {};
			bag.store.config = savedCfg;
			assertEqual(memoryChip.merged, undefined, '徽章不再自带合并段');
			const escalatedChip = bag.chipOf({ decidedBy: 'human', outcome: 'allowed-once', aiSource: 'ai', fpMode: 'normalized', droppedKeys: ['limit'], memoryCount: 3 }, (k) => k);
			assertEqual(escalatedChip.pre, 'chip.aiRejected');
			// 行渲染器从 ApprovalPage 里提出来了：它只吃 opts，缺一个字段就会当场红
			const rowOpts = {
				t: (k) => k,
				view: { diff: null },
				copiedId: '',
				isReasonOpen: function () { return false; },
				openDiff: function () {},
				copyRow: function () {},
				toggleReason: function () {},
			};
			const rowNode = bag.approvalRowNode({ id: 'r1', ts: 1700000000000, toolName: 'pwsh', decidedBy: 'human', outcome: 'allowed-once', aiSource: 'ai', reason: 'escalate', aiReason: 'needs a human', riskLevel: 'medium', memoryCount: 2, fpMode: 'normalized', droppedKeys: ['limit'] }, rowOpts);
			assertEqual(rowNode.props.className, 'ah-row');
			assertTrue(bag.approvalRowNode({ id: 'r2', ts: 1, toolName: 'ops_bash', decidedBy: 'memory', outcome: 'allowed-once', memoryCount: 3 }, rowOpts).props.className === 'ah-row', '记忆行同样能独立渲染');
			// 记忆页分桶：文件是共同主体；没有文件就按指纹各算各的（否则两条无关命令会被加在一起）
			assertEqual(bag.memoryBucketId('pwsh', '', 'aaa'), bag.memoryBucketId('pwsh', '', 'aaa'));
			assertTrue(bag.memoryBucketId('pwsh', '', 'aaa') !== bag.memoryBucketId('pwsh', '', 'bbb'), '同工具不同指纹不能并成一桶');
			assertEqual(bag.memoryBucketId('edit', 'D:/x/a.md', 'aaa'), bag.memoryBucketId('edit', 'D:/x/a.md', 'bbb'), '同一文件的不同指纹合成一桶');
			// 指纹在记忆 key 里（sid\0fp）：服务端不给字段时也要能取出来，否则删除会静默打空
			assertEqual(bag.rowFingerprintOf({ fingerprint: 'abc' }), 'abc');
			assertEqual(bag.rowFingerprintOf({ key: 'session-1\u0000deadbeef' }), 'deadbeef');
			assertEqual(bag.rowFingerprintOf({ key: 'no-separator' }), '');
			// 日期左边的模型名：评审车道优先于会话车道
			assertEqual(bag.rowModelOf({ decidedBy: 'human', aiModel: 'p/reviewer', routeModel: 'p/lane' }).text, 'p/reviewer');
			assertEqual(bag.rowModelOf({ decidedBy: 'ai', routeModel: 'p/lane' }).text, 'p/lane');
			assertEqual(bag.rowModelOf({ decidedBy: 'human' }), null, '没经过 AI 就没有模型名');
			const bare = bag.laneParts('ops-lane');
			assertEqual(bare.provider, '', '没有提供商就不显示');
			assertEqual(bare.model, 'ops-lane');
			// 记账型调用（plugin_manager 等）显示成一句话；动作可翻中文，目标永远原样
			assertEqual(bag.actionOf({ argsText: '{"action":"install_bundle","target":"x"}' }), 'install_bundle', '原始动作名要留出来，搜索用');
			assertEqual(bag.actionLabelOf({ argsText: '{"action":"set_bundle"}' }), '设置包', '名词型动作按工具覆盖');
			assertEqual(bag.actionLabelOf({ argsText: '{"action":"frobnicate"}' }), '', '不认识的动作用英文原文，不猜');
			// 动作中文化是开关（默认关）：开着看中文，关着看英文原名；搜索语料与开关无关
			const savedConfig = bag.store.config;
			bag.store.config = { translateActions: true };
			assertEqual(bag.foldedOf({ argsText: '{"action": "list_plugins", "limit": 10, "offset": 240}' }), '列出插件');
			assertEqual(bag.timelineTextOf((k) => k, { toolName: 'plugin_manager', argsText: '{"action":"list_plugins","limit":10,"offset":240}' }), '列出插件');
			assertEqual(bag.timelineTextOf((k) => k, { toolName: 'plugin_manager', argsText: '{"action":"remove_bundle","target":"dsh-cost-meter"}' }), '卸载包 dsh-cost-meter');
			bag.store.config = { translateActions: false };
			assertEqual(bag.foldedOf({ argsText: '{"action":"install_bundle","target":"@linxin666/dsh-web-all@0.4.18"}' }), 'install_bundle @linxin666/dsh-web-all@0.4.18', '关掉开关回到英文原名');
			assertEqual(bag.actionLabelOf({ argsText: '{"action":"set_bundle"}' }), '设置包', '中文标签照样算进搜索语料');
			bag.store.config = savedConfig;
			assertEqual(bag.foldedOf({ argsText: '{"action":"x","command":"git status"}' }), null, '有真命令就照旧拆包');
			assertEqual(bag.foldedOf({ argsText: '{"file_path":"D:/x/a.md","content":"body"}' }), null, '文件行不受影响');
			assertEqual(bag.foldedOf({ argsText: 'not json' }), null);
			// 没有命令也没有路径的调用：正文只给首行 + 行数，认不出的参数降级成 key: value
			const tp = function (k, p) { return p === undefined ? k : k + '|' + String(p.text) + '|' + String(p.n); };
			const codeArgs = JSON.stringify({ code: 'const fs = await import("node:fs");\nconst link = "C:/x";' });
			assertEqual(bag.valueOf({ argsText: codeArgs }, tp), 'row.bodyLine|const fs = await import("node:fs");|2', 'run_code 只给首行 + 行数');
			assertEqual(bag.timelineTextOf(tp, { toolName: 'run_code', argsText: codeArgs }), 'row.bodyLine|const fs = await import("node:fs");|2', '时间线不再铺转义过的 JSON');
			assertEqual(bag.valueOf({ argsText: '{"content":"line1\\nline2\\nline3"}' }, tp), 'row.bodyLine|line1|3');
			assertEqual(bag.valueOf({ argsText: '{"query":"needle"}' }, tp), 'needle', '短标识符直接显示');
			assertEqual(bag.valueOf({ argsText: '{"foo":1,"bar":"x"}' }, tp), 'foo: 1 · bar: x', '认不出的参数降级，不铺 JSON');
			assertTrue(bag.valueOf({ argsText: '{"foo":1,"bar":"x"}' }, tp).indexOf('{"') < 0, '正文里不再出现 JSON 花括号');
			// 复制给"能粘贴的东西"：正文型给正文本身（理由/描述留在台账里），记账型给完整原始参数
			const codeMeta = JSON.stringify({ code: 'line1\nline2', description: 'why', justification: 'because' });
			assertEqual(bag.copyTextOf({ argsText: codeMeta }), 'line1\nline2', 'run_code 复制的是代码，不是带理由的外壳');
			assertEqual(bag.copyTextOf({ argsText: '{"action":"list_plugins","limit":10}' }), '{"action":"list_plugins","limit":10}', '记账型复制仍是完整原始参数');
			assertEqual(bag.copyTextOf({ argsText: '{"command":"git status","description":"d"}' }), 'git status', '命令型复制的是命令');
		},
	},
	{
		name: '轮询必须带 session：不许再退化成全局广播',
		async fn() {
			const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');
			assertTrue(src.indexOf("'/entries?session='") > 0 || src.indexOf("'/entries?session=' + encodeURIComponent(sid)") > 0, 'dock 拉列表必须带会话');
			assertTrue(src.indexOf("'/stream?session='") > 0, '实时通道按会话订阅');
			assertTrue(src.indexOf("argsSummary || reasonOf(entry)") > 0);
			assertTrue(src.indexOf('ah-switch') > 0, '设置项用滑块');
			assertTrue(src.indexOf('ah-icon-btn') > 0, '卡片按钮用图标');
			assertTrue(src.indexOf('ah-divider') > 0, '新增审批分割线');
			assertTrue(src.indexOf("icon('search', 16)") > 0, '查找改成放大镜图标');
		},
	},
	{
		name: '某个席位注册抛错不影响其余席位',
		async fn() {
			const def = await loadDefinition();
			await withDocument(async function () {
				const seats = [];
				const errors = [];
				const original = console.error;
				console.error = function () { errors.push([].slice.call(arguments).join(' ')); };
				try {
					const mod = def.factory(requireStub);
					mod.apply({
						locale: { register: function () {} },
						effect: function (factory) { factory(); },
						slots: {
							inject: function (name, callback) { if (name === 'conversation.view') throw new Error('seat missing'); callback(); },
							register: function (config) { seats.push(config); return function () {}; },
						},
					});
					assertEqual(seats.length, 2, '另外两个席位仍然挂上');
					assertEqual(errors.length, 1);
				} finally {
					console.error = original;
				}
			});
		},
	},
	{
		name: 'client: 高级设置的结构护栏（五组齐全、Hook 在早退之前、默认值覆盖所有字段）',
		async fn() {
			const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');
			for (const key of ['config.secRhythm', 'config.secPrompt', 'config.secScope', 'config.secPreview', 'config.secDebug']) {
				assertTrue(src.includes("'" + key + "'"), '缺少分组标题 ' + key);
			}
			// 1.1.0 的事故：hook 声明写在了 if (draft === null) return 之后，草稿到达时
			// hook 数量变化 → 整张卡渲染成空。这条断言把那类改动挡在提交之前。
			const cardAt = src.indexOf('function ConfigCard');
			assertTrue(cardAt > 0, '找不到 ConfigCard');
			const rest = src.slice(cardAt + 20);
			const nextFn = rest.search(/\n    function [A-Za-z]/);
			const card = nextFn < 0 ? rest : rest.slice(0, nextFn);
			const early = card.indexOf('if (draft === null) return');
			const firstHook = card.search(/React\.use(State|Effect|Ref|Memo)\(/);
			assertTrue(early > 0, 'ConfigCard 里找不到早退');
			assertTrue(firstHook > 0 && firstHook < early, 'ConfigCard 的 Hook 必须全部声明在早退之前');
			// 卡片预览 = 设置内的「假会话页」：悬浮卡在假页里绝对定位，不再往真实页面弹
			assertTrue(src.includes('ah-fake-chat'), '缺少假会话页容器');
			assertTrue(src.includes('ah-fake-float'), '悬浮卡必须挂在假页内部');
			assertTrue(src.includes('ah-fake-panel'), '缺少假宿主审批面板');
			assertTrue(src.includes('PREVIEW_WIDTHS'), '缺少宽度三档');
			assertTrue(src.includes('PREVIEW_STATES'), '预览状态必须按座位分组');
			assertTrue(src.includes('buildFloatCard(t, previewFloatRow'), '悬浮卡预览必须用真实构建函数');
			assertTrue(src.includes('ah-float-preview'), '假页里的悬浮卡需要自己的定位覆盖');
			assertTrue(src.includes('tryFloat(') === false, '不该再往真实页面弹卡');
			assertTrue(src.includes('previewSamples') === false, '按颜色分的样张表应已删除');
			assertTrue(src.includes('PREVIEW_KINDS') === false, '旧的六色状态表应已删除');
			const defaultsAt = src.indexOf('const ADVANCED_DEFAULTS');
			assertTrue(defaultsAt > 0, '找不到 ADVANCED_DEFAULTS');
			const defaultsBlock = src.slice(defaultsAt, src.indexOf('const ADVANCED_GROUP_FIELDS'));
			for (const field of ['pollMs', 'maxEntriesPerSession', 'humanFirstMs', 'reviewTimeoutMs', 'aiCacheTtlMs', 'aiReasonChars', 'clearEnabled', 'promptAppend', 'reviewerLocale', 'aiBudgetPerTurn', 'aiBreakerFails', 'aiTools', 'aiToolsDeny', 'snapshotRetentionDays', 'debugHeaders', 'debugReview', 'strictVerdict']) {
				assertTrue(defaultsBlock.includes(field + ':'), 'ADVANCED_DEFAULTS 缺 ' + field);
			}
		},
	},
];
