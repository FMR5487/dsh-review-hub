import { readFileSync } from 'node:fs';
import { assertEqual, assertTrue } from './helpers.mjs';
import { KNOB_KEYS } from '../src/store.js';

const REACT_STUB = {
	createElement: function (type, props) {
		return { type: type, props: props || {} };
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
			// 日期左边的模型名：评审车道优先于会话车道
			assertEqual(bag.rowModelOf({ decidedBy: 'human', aiModel: 'p/reviewer', routeModel: 'p/lane' }).text, 'p/reviewer');
			assertEqual(bag.rowModelOf({ decidedBy: 'ai', routeModel: 'p/lane' }).text, 'p/lane');
			assertEqual(bag.rowModelOf({ decidedBy: 'human' }), null, '没经过 AI 就没有模型名');
			const bare = bag.laneParts('ops-lane');
			assertEqual(bare.provider, '', '没有提供商就不显示');
			assertEqual(bare.model, 'ops-lane');
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
];
