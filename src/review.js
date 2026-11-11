/**
 * L3 AI review.
 *
 * One model call, one JSON answer, and only two outcomes: `allow` or `ask`.
 * The reviewer has **no veto**: anything it cannot decide cleanly — a timeout, a
 * non-JSON reply, a rate limit, a request over budget — becomes `ask`, which
 * means the human prompt takes over. That is the whole difference from the
 * plugin this replaces: a reviewer that is unsure must not be able to deny.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DEFAULT_BUDGET_WINDOW_MS = 60000;
/** Verdicts this many bytes are written to disk at most every 5s; the map is the truth. */
export const CACHE_FLUSH_MS = 5000;
export const CACHE_MAX_ENTRIES = 200;
/** A verdict is ~30 tokens; capping keeps a chatty model from eating the budget. */
export const MAX_TOKENS = 64;
export const BREAKER_OPEN_MS = 300000;
const MAX_REASON = 160;

/** Fields the host may use for token accounting; naming differs per provider. */
export function readUsage(raw) {
	if (raw === null || typeof raw !== 'object') return undefined;
	const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
	const details = raw.prompt_tokens_details ?? raw.promptTokensDetails ?? {};
	const promptTokens = num(raw.promptTokens ?? raw.prompt_tokens ?? raw.input_tokens ?? raw.inputTokens);
	const completionTokens = num(raw.completionTokens ?? raw.completion_tokens ?? raw.output_tokens ?? raw.outputTokens);
	const cacheRead = num(raw.cacheRead ?? raw.cache_read ?? raw.cache_read_input_tokens ?? raw.cachedTokens ?? details.cached_tokens ?? details.cachedTokens);
	const cacheWrite = num(raw.cacheWrite ?? raw.cache_write ?? raw.cache_creation_input_tokens ?? raw.cacheCreationInputTokens);
	if (promptTokens === 0 && completionTokens === 0 && cacheRead === 0 && cacheWrite === 0) return undefined;
	return { promptTokens, completionTokens, cacheRead, cacheWrite };
}

const PROMPT_LINES = [
	'You review one sandbox-escalation request from an AI coding agent.',
	'Answer with ONE JSON object and nothing else:',
	'{"decision":"allow"|"ask","risk":"low"|"medium"|"high","reason":"<=%CAP% chars"}',
	'Rules:',
	'- "allow" only when the action is clearly reversible, scoped, and matches the stated reason.',
	'- "ask" whenever you are unsure, the evidence is missing, or the action is destructive.',
	'- You may never deny. If you would deny, answer "ask".',
	'Risk levels — pick the level of the *effects*, not of the wording:',
	'- "low": reads or lists; writes inside the workspace; a plain build/test command.',
	'- "medium": writes outside the workspace, asks for a wider sandbox, installs packages,',
	'  touches git history in a recoverable way, or runs a command whose target is unclear.',
	'- "high": deletes or discards data, touches credentials, executes remote code, changes',
	'  system settings, or does something batch-wide and irreversible.',
	'Write "reason" in %LANG%.',
];

/**
 * The reviewer's system prompt. Two knobs, both user-facing settings: how long the reason
 * may be, and which language it must be written in (the panel's language, not the request's).
 */
const LANG_NAMES = {
	zh: 'Chinese',
	en: 'English',
	ja: 'Japanese',
	ko: 'Korean',
	de: 'German',
	fr: 'French',
	es: 'Spanish',
	ru: 'Russian',
	pt: 'Portuguese',
	'zh-Hant': 'Traditional Chinese',
};
function langNameOf(code) {
	const key = typeof code === 'string' ? code.trim() : '';
	if (key === '') return '';
	if (LANG_NAMES[key] !== undefined) return LANG_NAMES[key];
	const base = key.split('-')[0];
	return LANG_NAMES[base] !== undefined ? LANG_NAMES[base] : key;
}
export function systemPromptFor(options = {}) {
	const raw = Number(options.reasonChars);
	const cap = Number.isFinite(raw) ? Math.max(40, Math.min(400, Math.round(raw))) : 80;
	const forced = langNameOf(options.locale);
	const lang = forced === '' ? 'the language of "reason on the request"' : forced;
	const base = PROMPT_LINES.join('\n').replace('%CAP%', String(cap)).replace('%LANG%', lang);
	// The append block is stated as a fact, not a plea: the rules above are enforced by
	// code (deny is downgraded there), so anything conflicting here is simply ignored.
	const extra = typeof options.append === 'string' ? options.append.trim().slice(0, 2000) : '';
	if (extra === '') return base;
	return base + '\n\nAdditional user preferences — they apply only where they do not conflict\nwith the rules above; the rules above are enforced by code, and any conflicting part\nof this block is ignored:\n' + extra;
}

const SYSTEM_PROMPT = systemPromptFor();

function textOf(value) {
	if (typeof value === 'string') return value;
	if (value === null || typeof value !== 'object') return '';
	for (const key of ['text', 'delta', 'content', 'textDelta', 'value']) {
		const candidate = value[key];
		if (typeof candidate === 'string') return candidate;
	}
	return '';
}

/** First balanced {...} in a string, ignoring braces inside strings. */
export function firstJsonObject(text) {
	if (typeof text !== 'string') return undefined;
	const open = text.indexOf('{');
	if (open < 0) return undefined;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = open; index < text.length; index += 1) {
		const char = text[index];
		if (escaped) { escaped = false; continue; }
		if (char === '\\') { escaped = true; continue; }
		if (char === '"') { inString = !inString; continue; }
		if (inString) continue;
		if (char === '{') depth += 1;
		else if (char === '}') {
			depth -= 1;
			if (depth === 0) {
				try {
					return JSON.parse(text.slice(open, index + 1));
				} catch {
					return undefined;
				}
			}
		}
	}
	return undefined;
}

const RISKS = new Set(['low', 'medium', 'high']);
const ALLOW_WORDS = new Set(['allow', 'allowed', 'approve', 'approved', 'allow-once']);
const ASK_WORDS = new Set(['ask', 'review', 'escalate']);
const DENY_WORDS = new Set(['deny', 'denied', 'reject', 'rejected', 'block', 'blocked']);

/**
 * Turn whatever the model said into a verdict, or undefined when it is unusable.
 * `deny` is deliberately downgraded: the reviewer cannot overrule the human.
 *
 * With `opts.strict` the published protocol is the only accepted shape — the field must
 * be named `decision`, the value must be a word we know, and `risk` must be a real level.
 * Synonyms and a missing risk are what let "a string that looks like JSON" reach the pass
 * path; strict mode turns those into `unparsed` → a human.
 */
export function parseVerdict(raw, opts = {}) {
	const text = typeof raw === 'string' ? raw : textOf(raw);
	const body = firstJsonObject(text);
	if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
	// Chat-shaped reviewers name the field differently and shout it in caps; the
	// meaning is the same, so read every spelling of the one decision they mean.
	const named = body.decision ?? body.verdict ?? body.action ?? body.result;
	const word = typeof named === 'string' ? named.trim().toLowerCase() : '';
	if (word === '') return undefined;
	const risk = typeof body.risk === 'string' && RISKS.has(body.risk.toLowerCase()) ? body.risk.toLowerCase() : 'unknown';
	const reason = typeof body.reason === 'string' ? body.reason.slice(0, MAX_REASON) : '';
	if (opts.strict === true) {
		if (typeof body.decision !== 'string') return undefined;
		if (risk === 'unknown') return undefined;
		if (body.reason !== undefined && typeof body.reason !== 'string') return undefined;
	}
	// A reviewer still has no veto: "deny" keeps its reasoning but lands as an ask.
	if (DENY_WORDS.has(word)) return { decision: 'ask', risk, reason };
	if (ALLOW_WORDS.has(word)) return { decision: 'allow', risk, reason };
	if (ASK_WORDS.has(word)) return { decision: 'ask', risk, reason };
	return undefined;
}

/** What the reviewer sees. Redacted summary only: never the raw argument blob. */
export function buildMessages(input) {
	const lines = [
		'tool: ' + (input.toolName || 'unknown'),
		'requester: ' + (input.agentKind || 'default'),
		'reason on the request: ' + String(input.reason ?? '').slice(0, 200),
		'arguments summary: ' + String(input.summary ?? '').slice(0, 240),
		'prior human approvals of this same operation in this session: ' + String(input.priorApprovals ?? 0),
	];
	if (input.note !== undefined) lines.push('note: ' + String(input.note).slice(0, 200));
	// Shape matches the host llm seam: system prompt separate, user content as blocks.
	return {
		system: SYSTEM_PROMPT,
		messages: [{ role: 'user', content: [{ type: 'text', text: lines.join('\n') }] }],
	};
}

/**
 * One streaming reviewer call, in the shape the host llm seam expects:
 * `{ provider, model, system, messages:[{role, content:[{type:'text', text}]}], temperature, signal }`.
 * Chunks are block events; the terminal one is `{ type:'finish', reason:{ kind } }`.
 * @returns {Promise<{text?:string, reason?:string}>}
 */
async function collect(llm, prompt, timeoutMs, route, extra, onChunk, outer) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	// The caller may cancel too (the human took the decision, so the answer is moot).
	// Aborting here stops the stream instead of paying for an answer nobody will read.
	if (outer !== undefined && outer !== null) {
		if (outer.aborted === true) controller.abort();
		else if (typeof outer.addEventListener === 'function') outer.addEventListener('abort', () => controller.abort());
	}
	const tail = extra !== null && typeof extra === 'object' ? extra : {};
	try {
		if (typeof llm?.stream === 'function') {
			const request = { ...tail, system: prompt.system, messages: prompt.messages, temperature: 0, signal: controller.signal };
			// The host rejects a stream call without an explicit route.
			if (typeof route?.provider === 'string' && route.provider !== '') request.provider = route.provider;
			if (typeof route?.model === 'string' && route.model !== '') request.model = route.model;
			const stream = await llm.stream(request);
			if (stream !== null && typeof stream === 'object' && typeof stream[Symbol.asyncIterator] === 'function') {
				let text = '';
				let blockText = '';
				let usage;
				for await (const chunk of stream) {
					// Names only, and only when the caller asked: this answers "does the host
					// hand us usage / prompt-cache counters at all?" without guessing.
					if (typeof onChunk === 'function' && chunk !== null && typeof chunk === 'object') onChunk(String(chunk.type ?? '?'), Object.keys(chunk).sort());
					if (chunk?.type === 'finish') {
						const kind = chunk.reason?.kind;
						if (kind !== undefined && kind !== 'stop') return { reason: 'reviewer ended with ' + String(kind) };
						break;
					}
					if (chunk?.type === 'usage' && usage === undefined) usage = readUsage(chunk.usage);
					text += typeof chunk?.delta?.text === 'string' ? chunk.delta.text : textOf(chunk);
					if (typeof chunk?.block?.text === 'string') blockText = chunk.block.text;
				}
				// Some hosts only publish the assembled block; use it when the deltas look empty.
				if (text.trim() === '' && blockText !== '') text = blockText;
				return { text: text, usage: usage };
			}
			return { text: textOf(stream) };
		}
		if (typeof llm?.complete === 'function') return { text: textOf(await llm.complete({ ...tail, system: prompt.system, messages: prompt.messages, temperature: 0, signal: controller.signal })) };
		if (typeof llm?.generate === 'function') return { text: textOf(await llm.generate({ ...tail, system: prompt.system, messages: prompt.messages, temperature: 0, signal: controller.signal })) };
		return { reason: 'no llm call surface' };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * @param {object} deps - getLlm(), getSettings(), now(), logger.
 */
export function createReviewer(deps = {}) {
	const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
	const cache = new Map();
	const windows = new Map();
	const breakers = new Map();
	const stats = { calls: 0, allows: 0, asks: 0, fallbacks: 0, cacheHits: 0, breakerOpens: 0, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 };
	/** Per-lane counters: swapping the reviewer is only judgeable lane by lane. */
	const byModel = new Map();
	const cachePath = typeof deps.cachePath === 'string' ? deps.cachePath : '';
	let cacheLoaded = cachePath === '';
	let cacheFlushAt = 0;
	let cacheTimer = null;
	/** Set false the first time a seam rejects the cap, so we stop asking for it. */
	let maxTokensSupported = true;

	/** Diagnostics hook (set only when the forensics switch is on); never throws. */
	function noteShape(kind, keys) {
		const sink = typeof deps.noteShape === 'function' ? deps.noteShape : null;
		if (sink === null) return;
		try {
			sink(kind, keys);
		} catch (error) {
			/* a diagnostic must never break a review */
		}
	}

	function laneOf(route) {
		const provider = typeof route?.provider === 'string' && route.provider !== '' ? route.provider : '';
		const model = typeof route?.model === 'string' && route.model !== '' ? route.model : '';
		return provider !== '' && model !== '' ? provider + '/' + model : 'session-lane';
	}

	function bumpLane(route, field) {
		const lane = laneOf(route);
		const bucket = byModel.get(lane) ?? { calls: 0, allows: 0, asks: 0, fallbacks: 0, cacheHits: 0, lastTs: 0, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 };
		bucket[field] = (bucket[field] ?? 0) + 1;
		bucket.lastTs = Date.now();
		byModel.set(lane, bucket);
	}

	/**
	 * Verdicts survive a restart on purpose: this host is restarted often, and the
	 * first batch of "new" operations after each restart would otherwise be paid for
	 * again. Expired rows are dropped at load, so the TTL still holds.
	 */
	async function loadCache() {
		if (cacheLoaded === true) return;
		cacheLoaded = true;
		if (cachePath === '') return;
		try {
			const doc = JSON.parse(await readFile(cachePath, 'utf8'));
			const ttl = Math.max(0, Number(settingsOf().aiCacheTtlMs) || 0);
			for (const row of Array.isArray(doc?.entries) ? doc.entries : []) {
				if (typeof row?.cacheKey !== 'string' || row?.verdict === undefined) continue;
				if (ttl > 0 && now() - Number(row.at) > ttl) continue;
				cache.set(row.cacheKey, { at: Number(row.at) || 0, verdict: row.verdict });
			}
		} catch {
			/* no cache on disk is the normal first run */
		}
	}

	/** Write-behind: the answerer must never wait on the disk. */
	function scheduleFlush() {
		if (cachePath === '' || cacheTimer !== null) return;
		const wait = Math.max(0, CACHE_FLUSH_MS - (now() - cacheFlushAt));
		cacheTimer = setTimeout(function () {
			cacheTimer = null;
			void flushCache();
		}, wait);
		if (typeof cacheTimer?.unref === 'function') cacheTimer.unref();
	}

	async function flushCache() {
		if (cachePath === '') return;
		cacheFlushAt = now();
		const entries = [...cache.entries()]
			.map(([cacheKey, row]) => ({ cacheKey, at: row.at, verdict: row.verdict }))
			.sort((a, b) => b.at - a.at)
			.slice(0, CACHE_MAX_ENTRIES);
		try {
			await mkdir(dirname(cachePath), { recursive: true });
			await writeFile(cachePath, JSON.stringify({ version: 1, entries }), 'utf8');
		} catch {
			/* a read-only disk only costs the cache */
		}
	}

	function settingsOf() {
		return typeof deps.getSettings === 'function' ? deps.getSettings() : {};
	}

	function budget(sessionId) {
		const window = windows.get(sessionId);
		const stamp = now();
		if (window === undefined || stamp - window.start > DEFAULT_BUDGET_WINDOW_MS) {
			const fresh = { start: stamp, count: 0 };
			windows.set(sessionId, fresh);
			return fresh;
		}
		return window;
	}

	function breakerOf(sessionId) {
		const entry = breakers.get(sessionId);
		if (entry === undefined) return { fails: 0, openUntil: 0 };
		if (entry.openUntil > 0 && entry.openUntil <= now()) {
			breakers.delete(sessionId);
			return { fails: 0, openUntil: 0 };
		}
		return entry;
	}

	function noteFailure(sessionId, settings) {
		const entry = breakerOf(sessionId);
		const fails = (entry.fails ?? 0) + 1;
		const limit = Math.max(1, Number(settings.aiBreakerFails) || 3);
		if (fails >= limit) {
			breakers.set(sessionId, { fails, openUntil: now() + BREAKER_OPEN_MS });
			stats.breakerOpens += 1;
			return true;
		}
		breakers.set(sessionId, { fails, openUntil: 0 });
		return false;
	}

	function noteSuccess(sessionId) {
		breakers.delete(sessionId);
	}

	const fallback = (source, reason) => ({ decision: 'ask', risk: 'unknown', reason, source });

	/**
	 * Review one approval.
	 * @returns {Promise<{decision:'allow'|'ask', risk:string, reason:string, source:string, latencyMs:number}>}
	 */
	async function review(input) {
		const started = now();
		const settings = settingsOf();
		const sessionId = String(input.sessionId ?? '');
		// A per-session entry wins over the global switch: that is how one session runs
		// unattended (AI off) while every other session keeps the reviewer on.
		const local = settings.aiEnabledLocal === null || typeof settings.aiEnabledLocal !== 'object' ? {} : settings.aiEnabledLocal;
		const aiOn = Object.prototype.hasOwnProperty.call(local, sessionId) ? local[sessionId] === true : settings.aiEnabled === true;
		if (aiOn !== true) return fallback('disabled', 'ai disabled');
		await loadCache();

		const open = breakerOf(sessionId);
		if (open.openUntil > 0) return fallback('breaker', 'reviewer circuit open');

		const window = budget(sessionId);
		const cap = Math.max(1, Number(settings.aiBudgetPerTurn) || 20);
		if (window.count >= cap) return fallback('budget', 'per-turn review budget spent');

		const cacheKey = String(input.cacheKey ?? '');
		if (input.cacheKey !== undefined && settings.aiCacheTtlMs > 0) {
			const hit = cache.get(cacheKey);
			if (hit !== undefined && now() - hit.at <= settings.aiCacheTtlMs) {
				stats.cacheHits += 1;
				bumpLane(input.route, 'cacheHits');
				return { ...hit.verdict, source: 'cache', lane: laneOf(input.route), latencyMs: now() - started };
			}
		}

		const llm = typeof deps.getLlm === 'function' ? deps.getLlm() : undefined;
		if (llm === null || llm === undefined) return fallback('unavailable', 'no llm service');

		window.count += 1;
		stats.calls += 1;
		bumpLane(input.route, 'calls');
		const prompt = Object.assign({}, buildMessages(input), {
			system: systemPromptFor({
				reasonChars: settings.aiReasonChars,
				// 'follow the UI' is the empty setting: fall back to the panel's own locale.
				locale: settings.reviewerLocale === '' ? settings.panelLocale : settings.reviewerLocale,
				append: settings.promptAppend,
			}),
		});
		const timeoutMs = Math.max(1000, Number(settings.reviewTimeoutMs) || 8000);
		let answer;
		try {
			answer = await collect(llm, prompt, timeoutMs, input.route, maxTokensSupported ? { maxTokens: MAX_TOKENS } : undefined, noteShape, input.signal);
			if (answer.reason !== undefined && maxTokensSupported === true) {
				// The seam may not know this option. Ask once more without it and stop
				// asking, rather than letting the cap disable the reviewer for good.
				const retry = await collect(llm, prompt, timeoutMs, input.route, undefined, undefined, input.signal);
				if (retry.reason === undefined) {
					maxTokensSupported = false;
					answer = retry;
				}
			}
		} catch (error) {
			noteFailure(sessionId, settings);
			stats.fallbacks += 1;
			bumpLane(input.route, 'fallbacks');
			// An aborted request is the leash, not a failure: name it so the panel can say
			// "timed out" instead of a generic error the human has to guess about.
			const message = error instanceof Error ? error.message : String(error);
			// Cancelled by handover is not a timeout: the human took the decision and this
			// answer became moot. Naming them apart keeps the ledger readable.
			const cancelled = input.signal !== undefined && input.signal !== null && input.signal.aborted === true;
			if (cancelled === true) return fallback('aborted', 'reviewer cancelled: the human decided first');
			const timedOut = error !== null && error !== undefined && (error.name === 'AbortError' || /abort/i.test(message) === true);
			if (timedOut === true) return fallback('timeout', 'reviewer timed out after ' + String(timeoutMs) + 'ms');
			return fallback('error', 'reviewer failed: ' + message.slice(0, 80));
		}
		// Parse first, judge the finish reason second: a truncated stream can still carry a
		// complete verdict, and treating every non-clean finish as a failure threw those away.
		const verdict = parseVerdict(answer.text, { strict: settings.strictVerdict === true });
		if (verdict === undefined) {
			if (typeof input.noteAnswer === 'function') {
				input.noteAnswer({ reason: answer.reason === undefined ? null : String(answer.reason).slice(0, 60), text: String(answer.text || '').slice(0, 300) });
			}
			noteFailure(sessionId, settings);
			stats.fallbacks += 1;
			bumpLane(input.route, 'fallbacks');
			if (answer.reason !== undefined) return fallback('error', String(answer.reason).slice(0, 60));
			return fallback('unparsed', 'reviewer reply was not a verdict');
		}
		noteSuccess(sessionId);
		if (answer.usage !== undefined) {
			stats.promptTokens += answer.usage.promptTokens;
			stats.completionTokens += answer.usage.completionTokens;
			stats.cacheReadTokens += answer.usage.cacheRead;
			const lane = byModel.get(laneOf(input.route));
			if (lane !== undefined) {
				lane.promptTokens = (lane.promptTokens ?? 0) + answer.usage.promptTokens;
				lane.completionTokens = (lane.completionTokens ?? 0) + answer.usage.completionTokens;
				lane.cacheReadTokens = (lane.cacheReadTokens ?? 0) + answer.usage.cacheRead;
			}
		}
		const verdictOut = answer.usage === undefined ? verdict : { ...verdict, usage: answer.usage };
		if (verdict.decision === 'allow') {
			stats.allows += 1;
			bumpLane(input.route, 'allows');
		} else {
			stats.asks += 1;
			bumpLane(input.route, 'asks');
		}
		if (input.cacheKey !== undefined && settings.aiCacheTtlMs > 0) {
			cache.set(cacheKey, { at: now(), verdict: { ...verdict, source: 'ai' } });
			while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
			scheduleFlush();
		}
		return { ...verdictOut, source: 'ai', lane: laneOf(input.route), latencyMs: now() - started };
	}

	return {
		review,
		stats: () => {
			// An entry past its TTL is not usable: the lookup already refuses it, and a sweep
			// may not have run yet. The panel's "审批缓存 N 条" has to count what can actually
			// answer, otherwise the number contradicts the hit/miss line right under it.
			const ttl = Math.max(0, Number(settingsOf().aiCacheTtlMs) || 0);
			const at = now();
			let live = 0;
			for (const hit of cache.values()) if (ttl > 0 && at - hit.at <= ttl) live += 1;
			return { ...stats, byModel: Object.fromEntries(byModel), cacheSize: live, cacheEntries: cache.size, maxTokensSupported };
		},
		breakerState: () => Object.fromEntries([...breakers.entries()].map(([key, value]) => [key, { ...value }])),
		reset(sessionId) {
			if (sessionId === undefined) {
				breakers.clear();
				cache.clear();
				windows.clear();
				return;
			}
			breakers.delete(sessionId);
			windows.delete(sessionId);
		},
	};
}
