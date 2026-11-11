/**
 * Session-scoped persistence for the hub: approval rows, the memory table, and
 * settings. Every write is atomic (tmp + rename) and serialized; a failing disk
 * degrades the plugin to memory-only instead of throwing into the answerer.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DEFAULT_AI_TOOLS } from './policy.js';

export const DOC_VERSION = 2;
export const ENTRIES_PER_SESSION = 200;
export const SESSION_CAP = 64;
/** Per-session reviewer pins: 32 sessions, an 80-char session id, a 120-char lane. */
export const LOCAL_ROUTES_MAX = 32;
export const LOCAL_KEY_MAX = 80;
export const LOCAL_VALUE_MAX = 120;

export const DEFAULT_SETTINGS = Object.freeze({
	aiEnabled: true,
	memoryEnabled: true,
	composerHint: true,
	// On by default: the human card is where the reviewer's advice is visible
	// *while* the decision is being made, which is the whole point of the AI layer.
	pendingCard: true,
	toastEnabled: true,
	toastQuietMs: 10000,
	/** Shows the card preview in the settings card; a debugging aid. */
	/** Keep the escalation reason out of the fingerprint, so counts can pile up. */
	fpIgnoreJustification: false,
	/** Open each row's description by default instead of on click. */
	autoExpandDescription: false,
	/** Hide knob arguments (limit/offset/…) in the displayed command; copy stays verbatim. */
	hideKnobs: true,
	/**
	 * Header forensics for the HTTP fence: record every request's header *names* (never
	 * values) so a proof cookie/header can be chosen from evidence instead of a guess.
	 */
	debugHeaders: false,
	/** Days to keep snapshots/ on disk; 0 = keep until the session cap evicts them. */
	snapshotRetentionDays: 0,
	/**
	 * Global file-level mode: fingerprint by tool + file path, so every edit of the same
	 * file counts as one operation and passes once the threshold is met.
	 */
	fileFingerprint: false,
	/**
	 * `{ "<sessionId>\0<filePath>": true }`: files whose approvals may auto-pass.
	 * Off by default and opt-in per file — an approval for one edit must never
	 * silently cover the next edit of the same file.
	 */
	fileAutoPass: Object.freeze({}),
	threshold: 3,
	aiFailurePolicy: 'ask',
	// How long the reviewer may run before we hand the decision to the human anyway.
	// 0 disables the handover, leaving reviewTimeoutMs as the only guard.
	humanFirstMs: 8000,
	// Raised from 8s: with humanFirstMs holding the handover, this is now purely the
	// reviewer's own leash, so it can be generous without making anyone wait.
	reviewTimeoutMs: 16000,
	aiBudgetPerTurn: 20,
	aiBreakerFails: 3,
	aiCacheTtlMs: 600000,
	// Off by default: the strict protocol catches "looks like JSON" replies by turning them
	// into unparsed → human, which is safer but asks the human more often.
	strictVerdict: false,
	// Names-only shape of the llm chunks, written to review-probe.log. Separate from
	// debugHeaders on purpose: one answers "which cookie may write", the other
	// "does the host expose prompt-cache counters" — they are used months apart.
	debugReview: false,
	// How long the reviewer's reason may be, and which language it must use ('' = follow
	// the request's own language). Both are prompt knobs, not behaviour knobs.
	aiReasonChars: 80,
	// User-supplied extra instructions, appended after the fixed rules with an explicit
	// precedence note: the built-in red lines are enforced in code, so this can only add
	// preference, never remove a rule.
	promptAppend: '',
	// Two card switches, default on: users who find the floating card noisy can silence
	// one without silencing the plain waiting hint.
	aiAdviceCard: true,
	dangerCard: true,
	// Per-session AI switch: a key here wins over the global aiEnabled, which is how one
	// session can run unattended while every other session keeps the reviewer on.
	aiEnabledLocal: {},
	reviewerLocale: '',
	// What the panel itself is showing; only used when reviewerLocale is 'follow the UI'.
	panelLocale: '',
	reviewerModel: '',
	/**
	 * `{ "<sessionId>": "provider/model" }`: a session named here ignores the global
	 * pin. The *presence* of a key is the decision — `''` means "follow this
	 * session's own lane" — so an empty value must never be normalized away.
	 */
	reviewerModelLocal: Object.freeze({}),
	clearEnabled: false,
	maxEntriesPerSession: ENTRIES_PER_SESSION,
	pollMs: 1000,
	exportScope: 'session',
	/** How long a hint card stays on screen, per kind; 0 = until the decision lands. */
	hintMs: Object.freeze({ ai: 30000, memory: 8000, pending: 0 }),
	/**
	 * Deltas on top of the built-in AI baseline (`DEFAULT_AI_TOOLS` in policy.js):
	 * `aiTools` adds tools, `aiToolsDeny` removes them and wins. The memory-tier tools
	 * (write/edit) are unaffected either way — they are the stronger rule.
	 */
	aiTools: Object.freeze([]),
	aiToolsDeny: Object.freeze([]),
	/** ai ceiling per requester kind: full | strict | off */
	agentPolicy: Object.freeze({
		default: 'full',
		subagent: 'strict',
		scheduled: 'strict',
		task_board: 'strict',
		unknown: 'strict',
	}),
});

const BOUNDS = {
	threshold: [1, 5],
	reviewTimeoutMs: [1000, 120000],
	humanFirstMs: [0, 120000],
	aiBudgetPerTurn: [1, 500],
	aiBreakerFails: [1, 20],
	aiCacheTtlMs: [0, 86400000],
	aiReasonChars: [40, 400],
	toastQuietMs: [0, 600000],
	maxEntriesPerSession: [20, 2000],
	pollMs: [250, 30000],
	snapshotRetentionDays: [0, 365],
};
const HINT_BOUNDS = { ai: [2000, 600000], memory: [2000, 600000], pending: [0, 600000] };
const AI_LEVELS = new Set(['full', 'strict', 'off']);

export function defaultRoot() {
	const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
		? process.env.DSH_HOME
		: join(homedir(), '.dsh');
	return join(home, 'storages', 'review-hub');
}

function clampInt(value, [low, high], fallback) {
	const numeric = Number(value);
	if (Number.isFinite(numeric) === false) return fallback;
	return Math.min(high, Math.max(low, Math.round(numeric)));
}

/**
 * Sanitize `reviewerModelLocal`: string keys and string values only, an 80-char
 * session id, a 120-char lane, 32 sessions — past that the oldest insertion is
 * evicted, like every other bounded map here. An empty value is a real decision
 * ("follow this session's lane") and must survive. Anything that is not a plain
 * object drops the whole map back to `{}` instead of half-adopting it.
 */
export function clampReviewerModelLocal(value) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
	const out = {};
	let size = 0;
	for (const [rawKey, rawLane] of Object.entries(value)) {
		if (typeof rawLane !== 'string') continue;
		const key = rawKey.slice(0, LOCAL_KEY_MAX);
		if (Object.prototype.hasOwnProperty.call(out, key) === false) {
			if (size >= LOCAL_ROUTES_MAX) {
				delete out[Object.keys(out)[0]];
				size -= 1;
			}
			size += 1;
		}
		out[key] = rawLane.slice(0, LOCAL_VALUE_MAX);
	}
	return out;
}

/**
 * Cut a pinned `provider/model` into its two halves.
 *
 * `providerIds` is the host catalog's id set: the longest id that prefixes the pin
 * wins, because a provider id may itself contain a '/' ("meta/llama"). With an empty
 * list this is byte-for-byte the old first-slash split. Shared by `routeOf()`
 * (src/index.js) and the `/models` `next` resolver (src/routes.js): one cut, one
 * behaviour.
 * @returns {{provider:string, model:string}|undefined}
 */
export function splitRoute(pinned, providerIds = []) {
	const text = typeof pinned === 'string' ? pinned.trim() : '';
	if (text === '') return undefined;
	let best = '';
	for (const id of Array.isArray(providerIds) ? providerIds : []) {
		if (typeof id !== 'string' || id === '') continue;
		if (text.startsWith(id + '/') === false) continue;
		if (text.length <= id.length + 1) continue;
		if (id.length > best.length) best = id;
	}
	if (best !== '') return { provider: best, model: text.slice(best.length + 1) };
	const at = text.indexOf('/');
	if (at > 0 && at < text.length - 1) return { provider: text.slice(0, at), model: text.slice(at + 1) };
	return undefined;
}

/** Merge a partial settings patch over a base and clamp every field. */
/** Only explicit `true` entries survive: a map is a list of opt-ins, not opt-outs. */
/** Ordered, de-duplicated tool names; anything that is not a string is dropped. */
export function clampAiTools(value) {
	const out = [];
	if (Array.isArray(value) === false) return out;
	for (const raw of value) {
		if (typeof raw !== 'string') continue;
		const name = raw.trim();
		if (name === '' || name.length > 80 || out.includes(name)) continue;
		out.push(name);
		if (out.length >= 40) break;
	}
	return out;
}

function clampFileAutoPass(value) {
	const out = {};
	if (value === null || typeof value !== 'object') return out;
	let kept = 0;
	for (const [key, flag] of Object.entries(value)) {
		if (flag !== true) continue;
		if (typeof key !== 'string' || key === '' || key.length > 340) continue;
		out[key] = true;
		kept += 1;
		if (kept >= 200) break;
	}
	return out;
}

export function clampSettings(patch, base = DEFAULT_SETTINGS) {
	const next = {
		...DEFAULT_SETTINGS,
		...base,
		agentPolicy: { ...DEFAULT_SETTINGS.agentPolicy, ...(base?.agentPolicy ?? {}) },
		hintMs: { ...DEFAULT_SETTINGS.hintMs, ...(base?.hintMs ?? {}) },
		reviewerModelLocal: { ...(base?.reviewerModelLocal ?? {}) },
		aiEnabledLocal: { ...(base?.aiEnabledLocal ?? {}) },
	};
	if (patch === null || typeof patch !== 'object') return next;
	// String settings need their own branch: the boolean loop and the numeric bounds both
	// ignore them, so without this they would be silently dropped on save.
	if (typeof patch.promptAppend === 'string') next.promptAppend = patch.promptAppend.slice(0, 2000);
	// Any short BCP-47-ish tag is allowed, so a language nobody hard-coded still works.
	const langOk = (value) => value === '' || (typeof value === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/.test(value));
	if (langOk(patch.reviewerLocale)) next.reviewerLocale = patch.reviewerLocale;
	if (langOk(patch.panelLocale)) next.panelLocale = patch.panelLocale;
	for (const key of ['aiEnabled', 'memoryEnabled', 'composerHint', 'pendingCard', 'toastEnabled', 'clearEnabled', 'hideKnobs', 'fpIgnoreJustification', 'autoExpandDescription', 'fileFingerprint', 'debugHeaders', 'strictVerdict', 'debugReview', 'aiAdviceCard', 'dangerCard']) {
		if (typeof patch[key] === 'boolean') next[key] = patch[key];
	}
	for (const [key, bounds] of Object.entries(BOUNDS)) {
		if (patch[key] === undefined || patch[key] === null) continue;
		next[key] = clampInt(patch[key], bounds, next[key]);
	}
	if (patch.aiFailurePolicy === 'ask') next.aiFailurePolicy = 'ask';
	if (typeof patch.reviewerModel === 'string') next.reviewerModel = patch.reviewerModel.slice(0, 120);
	// The whole map, not one key: the panel writes the session -> lane table as it
	// stands, so an entry that is missing here is an entry the human removed.
	if (patch.reviewerModelLocal !== undefined && patch.reviewerModelLocal !== null) {
		next.reviewerModelLocal = clampReviewerModelLocal(patch.reviewerModelLocal);
	}
	if (patch.exportScope === 'session' || patch.exportScope === 'all') next.exportScope = patch.exportScope;
	if (patch.fileAutoPass !== undefined && patch.fileAutoPass !== null) next.fileAutoPass = clampFileAutoPass(patch.fileAutoPass);
	// The built-in baseline is code, not a setting: names already covered by it are
	// dropped so the field only ever shows the delta (an older build wrote the whole
	// list here, and it read as one unreadable line).
	if (patch.aiTools !== undefined && patch.aiTools !== null) {
		next.aiTools = clampAiTools(patch.aiTools).filter((name) => DEFAULT_AI_TOOLS.includes(name) === false);
	}
	if (patch.aiToolsDeny !== undefined && patch.aiToolsDeny !== null) next.aiToolsDeny = clampAiTools(patch.aiToolsDeny);
	if (patch.hintMs !== null && typeof patch.hintMs === 'object') {
		for (const [kind, bounds] of Object.entries(HINT_BOUNDS)) {
			const value = patch.hintMs[kind];
			if (value === undefined || value === null) continue;
			next.hintMs[kind] = clampInt(value, bounds, next.hintMs[kind]);
		}
	}
	if (patch.agentPolicy !== null && typeof patch.agentPolicy === 'object') {
		for (const kind of ['default', 'subagent', 'scheduled', 'task_board', 'unknown']) {
			const value = patch.agentPolicy[kind];
			if (typeof value === 'string' && AI_LEVELS.has(value)) next.agentPolicy[kind] = value;
		}
	}
	return next;
}

/** Last two path segments, lower-cased: the part that identifies the target. */
/**
 * The file a call touches, if its arguments name one. File-level counters key on
 * this; tools that name no file simply get no file stats.
 */
export function filePathOf(argsText) {
	const text = typeof argsText === 'string' ? argsText : '';
	if (text.trim().charAt(0) !== '{') return '';
	try {
		const parsed = JSON.parse(text);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
		for (const key of ['file_path', 'path', 'target_path']) {
			if (typeof parsed[key] === 'string' && parsed[key] !== '') return parsed[key].slice(0, 400);
		}
	} catch {
		/* not JSON: no file to speak of */
	}
	return '';
}

export function shrinkPaths(text) {
	const shrink = (match) => {
		const parts = String(match).split(/[\\/]+/).filter((part) => part !== '');
		return '…/' + parts.slice(-2).join('/').toLowerCase();
	};
	return String(text ?? '')
		.replace(/[A-Za-z]:[\\/][^\s"'\u0060|;:]+/g, shrink)
		.replace(/(^|[\s"'(=])\/(?:[^\s"'\u0060|;:]+\/)+[^\s"'\u0060|;:]+/g, (match, lead) => lead + shrink(match.slice(lead.length)));
}

/**
 * Knobs: arguments that only change *which slice* of the same operation is asked
 * for, never *what* operation it is (paging, counts, timeouts).
 *
 * Direction matters more than the contents. This is a delete-these-keys list, not
 * a keep-those-keys list: every key nobody listed stays in the fingerprint
 * material, so an unfamiliar field keeps two operations apart. An over-merge can
 * auto-approve something no human ever approved; an under-merge costs one extra
 * prompt. Only add a key here with a real split record to point at — never remove
 * one.
 */
export const KNOB_KEYS = Object.freeze([
	'limit', 'offset', 'page', 'size', 'count', 'max_results', 'maxResults',
	'since', 'until', 'recent', 'timeout', 'timeoutMs', 'graceMs',
	// Prose that describes *why* the caller is asking, not what will run: two
	// identical commands with different descriptions are the same operation, and
	// splitting them is how a memory count never reaches the threshold.
	// `justification` deliberately stays: it is the evidence a human reads before
	// granting an escalation, so it must keep separate requests apart.
	'description',
]);

/**
 * Tools whose every argument is semantic (e.g. a hypothetical `resize_window`'s
 * `size`): listed here, that tool goes back to byte-exact matching. Empty by
 * design — default is to strip knobs, and each problem found locks one tool down.
 */
export const EXACT_TOOLS = Object.freeze([]);

/**
 * Strip the knobs from one argument text.
 * @returns {{text:string, mode:'normalized'|'exact', droppedKeys:string[]}}
 *   `text` is the material to hash; `mode` is exact when the arguments were not a
 *   plain JSON object (a shell command line is all semantics).
 */
/**
 * @param {{ignoreJustification?:boolean}} [opts] `ignoreJustification` is the
 *   user's own trade-off: an escalation reason is evidence worth reading, but it
 *   also keeps identical commands from ever reaching the auto-pass threshold.
 */
export function normalizeFingerprintArgs(toolName, argsText, opts = {}) {
	const text = typeof argsText === 'string' ? argsText : '';
	const ignoreJustification = opts !== null && opts !== undefined && opts.ignoreJustification === true;
	if (EXACT_TOOLS.includes(toolName)) return { text, mode: 'exact', droppedKeys: [] };
	if (text.trim() === '' || text.trim().charAt(0) !== '{') return { text, mode: 'exact', droppedKeys: [] };
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { text, mode: 'exact', droppedKeys: [] };
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { text, mode: 'exact', droppedKeys: [] };
	const droppedKeys = [];
	const kept = {};
	for (const key of Object.keys(parsed).sort()) {
		if (KNOB_KEYS.includes(key) || (ignoreJustification === true && key === 'justification')) {
			droppedKeys.push(key);
			continue;
		}
		kept[key] = parsed[key];
	}
	return { text: JSON.stringify(kept), mode: 'normalized', droppedKeys };
}

/**
 * The fingerprint plus the material it was computed from.
 *
 * The material is stored on the memory row so a future KNOB_KEYS addition can
 * recompute counts instead of asking the human to teach the same thing again.
 * @returns {{fp:string, material:string, mode:'normalized'|'exact', droppedKeys:string[]}}
 */
export function fingerprintOf(toolName, argsText, opts) {
	const normalized = normalizeFingerprintArgs(toolName, argsText, opts);
	const material = String(toolName ?? '') + '\u0000' + shrinkPaths(normalized.text);
	return {
		fp: createHash('sha1').update(material).digest('hex'),
		material,
		mode: normalized.mode,
		droppedKeys: normalized.droppedKeys,
	};
}

/** Stable fingerprint of "the same operation" within one session. */
export function fingerprint(toolName, argsText, opts) {
	return fingerprintOf(toolName, argsText, opts).fp;
}

/**
 * Fingerprint of "the same file" rather than "the same text": what the global
 * file-level mode remembers. Same tool + same path = one operation, whatever the
 * content says.
 */
export function fileFingerprintOf(toolName, filePath) {
	const material = String(toolName ?? '') + '\u0000file\u0000' + String(filePath ?? '');
	return createHash('sha1').update(material).digest('hex');
}

export function memoryKey(sessionId, fp) {
	return String(sessionId) + '\u0000' + String(fp);
}

export function createStore(options = {}) {
	const root = typeof options.root === 'string' && options.root.length > 0 ? options.root : defaultRoot();
	const entriesPath = join(root, 'entries.json');
	const memoryPath = join(root, 'memory.json');
	const settingsPath = join(root, 'settings.json');

	const sessions = new Map();
	/** Real-time watchers: one SSE connection per open page hangs off these. */
	const watchers = new Set();
	const cleared = {};
	const memory = new Map();
	let settings = { ...DEFAULT_SETTINGS, agentPolicy: { ...DEFAULT_SETTINGS.agentPolicy } };
	let degraded = false;
	let loading;
	let chain = Promise.resolve();

	function subscribe(watcher) {
		if (typeof watcher !== 'function') return () => {};
		watchers.add(watcher);
		return () => {
			watchers.delete(watcher);
		};
	}

	/** Tell every watcher; a throwing watcher must not cost the others their event. */
	function announce(event) {
		for (const watcher of [...watchers]) {
			try {
				watcher(event);
			} catch {
				/* the row is already persisted; a half-dead stream is not a data problem */
			}
		}
	}

	const serialize = (task) => {
		const run = chain.then(task).then((value) => value, () => undefined);
		chain = run;
		return run;
	};

	const writeAtomic = async (path, value) => {
		await mkdir(root, { recursive: true });
		const tmp = path + '.tmp';
		await writeFile(tmp, JSON.stringify(value), 'utf8');
		await rename(tmp, path);
	};

	const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

	async function ensureLoaded() {
		if (loading === undefined) {
			loading = (async () => {
				try {
					const doc = await readJson(entriesPath);
					if (doc?.cleared !== null && typeof doc?.cleared === 'object') {
						for (const [key, value] of Object.entries(doc.cleared)) {
							if (Number.isFinite(Number(value))) cleared[String(key)] = Number(value);
						}
					}
					if (doc?.sessions !== null && typeof doc?.sessions === 'object') {
						for (const [key, list] of Object.entries(doc.sessions)) {
							if (Array.isArray(list)) sessions.set(String(key), list.filter((row) => row !== null && typeof row === 'object'));
						}
					}
				} catch (error) {
					if (error?.code !== 'ENOENT') degraded = true;
				}
				try {
					const doc = await readJson(memoryPath);
					if (doc?.entries !== null && typeof doc.entries === 'object') {
						for (const [key, row] of Object.entries(doc.entries)) {
							if (row !== null && typeof row === 'object') memory.set(String(key), row);
						}
					}
				} catch (error) {
					if (error?.code !== 'ENOENT') degraded = true;
				}
				try {
					settings = clampSettings(await readJson(settingsPath), DEFAULT_SETTINGS);
				} catch (error) {
					if (error?.code !== 'ENOENT') degraded = true;
				}
			})();
		}
		return loading;
	}

	const persistEntries = () => serialize(async () => {
		try {
			await writeAtomic(entriesPath, { version: DOC_VERSION, sessions: Object.fromEntries(sessions), cleared });
			degraded = false;
		} catch {
			degraded = true;
		}
	});

	const persistMemory = () => serialize(async () => {
		try {
			await writeAtomic(memoryPath, { version: DOC_VERSION, entries: Object.fromEntries(memory) });
			degraded = false;
		} catch {
			degraded = true;
		}
	});

	/** The newest watermark that hides a session's old rows, or 0. */
	function clearedAt(session) {
		if (typeof session !== 'string' || session === '') return 0;
		const value = Number(cleared[session]);
		return Number.isFinite(value) ? value : 0;
	}

	function rowsOf(session) {
		const wanted = typeof session === 'string' && session !== '' ? session : undefined;
		const out = [];
		for (const [key, list] of sessions) {
			if (wanted !== undefined && key !== wanted) continue;
			for (const row of list) out.push({ ...row });
		}
		out.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
		return out;
	}

	async function record(row) {
		await ensureLoaded();
		const sessionId = typeof row?.sessionId === 'string' && row.sessionId !== '' ? row.sessionId : '';
		if (sessionId === '') return undefined;
		const list = sessions.get(sessionId) ?? [];
		// One request, one row: a second writer for the same call id updates it.
		const index = typeof row.callId === 'string'
			? list.findIndex((entry) => entry.callId === row.callId)
			: -1;
		if (index >= 0) list[index] = { ...list[index], ...row };
		else list.push({ ...row });
		if (list.length > settings.maxEntriesPerSession) list.splice(0, list.length - settings.maxEntriesPerSession);
		sessions.set(sessionId, list);
		while (sessions.size > SESSION_CAP) {
			const oldest = sessions.keys().next();
			if (oldest.done === true) break;
			sessions.delete(oldest.value);
		}
		await persistEntries();
		announce({ kind: 'entry', row: { ...row } });
		return row;
	}

	async function query(opts = {}) {
		await ensureLoaded();
		const floor = Math.max(clearedAt(opts.session), Number(opts.since) || 0);
		const limit = Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0 ? Math.floor(Number(opts.limit)) : 500;
		const rows = rowsOf(opts.session).filter((row) => (Number(row.ts) || 0) > floor);
		return { entries: rows.slice(0, limit), cursor: rows.length > 0 ? Number(rows[0].ts) || floor : floor, degraded };
	}

	async function stats(opts = {}) {
		await ensureLoaded();
		const floor = clearedAt(opts.session);
		const rows = rowsOf(opts.session).filter((row) => (Number(row.ts) || 0) > floor);
		const out = { total: rows.length, allow: 0, deny: 0, cancelled: 0, unavailable: 0, ai: 0, memory: 0, human: 0, external: 0, fallback: 0, avgDecisionMs: 0 };
		let sum = 0;
		let counted = 0;
		// The reviewer tally is derived from the rows, not from the reviewer's in-memory
		// counters: those reset with the host, and the panel prints them directly under
		// row-derived totals, so a restart made "3 approvals · 3 allowed" sit next to
		// "1 call · ask 1" and read as "the AI only saw one of them".
		const reviewer = { calls: 0, allows: 0, asks: 0, fallbacks: 0, cacheHits: 0, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, byModel: {} };
		for (const row of rows) {
			if (row.outcome === 'allowed-once') out.allow += 1;
			else if (row.outcome === 'rejected') out.deny += 1;
			else if (row.outcome === 'cancelled') out.cancelled += 1;
			else out.unavailable += 1;
			if (typeof row.decidedBy === 'string' && out[row.decidedBy] !== undefined) out[row.decidedBy] += 1;
			const ms = Number(row.decisionMs);
			if (Number.isFinite(ms) && ms >= 0) {
				sum += ms;
				counted += 1;
			}
			const source = typeof row.aiSource === 'string' ? row.aiSource : '';
			if (source !== '') {
				const lane = typeof row.aiModel === 'string' && row.aiModel !== ''
				? row.aiModel
				: (typeof row.routeModel === 'string' && row.routeModel !== '' ? row.routeModel : '(unknown)');
				const bucket = reviewer.byModel[lane] ?? { calls: 0, allows: 0, asks: 0, aborted: 0, fallbacks: 0, cacheHits: 0, lastTs: 0, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 };
				// A cache hit is a verdict *without* a model call, so it is counted apart —
				// exactly how review.js counts it live.
				// "calls" means every request that was actually sent, not just the successful
				// ones: otherwise a lane with 8 failures reported 0 calls next to 8 errors.
				if (source !== 'cache') {
					reviewer.calls += 1;
					bucket.calls += 1;
				}
				if (source === 'cache') {
					reviewer.cacheHits += 1;
					bucket.cacheHits += 1;
				}
				if (source === 'ai' || source === 'cache') {
					if (row.decidedBy === 'ai') {
						reviewer.allows += 1;
						bucket.allows += 1;
					} else {
						reviewer.asks += 1;
						bucket.asks += 1;
					}
				} else if (source === 'aborted') {
					// Counted as a call above; broken out as 中断 so it never reads as a failure.
					
					reviewer.aborted = (Number(reviewer.aborted) || 0) + 1;
					bucket.aborted = (Number(bucket.aborted) || 0) + 1;
				} else {
					// timeout / error / unparsed / breaker / budget / unavailable: asked and could
					// not answer. This bucket is what the panel calls 错误.
					reviewer.fallbacks += 1;
					bucket.fallbacks += 1;
				}
				const usage = row.aiUsage === null || typeof row.aiUsage !== 'object' ? null : row.aiUsage;
				if (usage !== null) {
					const prompt = Number(usage.promptTokens) || 0;
					const completion = Number(usage.completionTokens) || 0;
					const cached = Number(usage.cacheRead) || 0;
					reviewer.promptTokens += prompt;
					reviewer.completionTokens += completion;
					reviewer.cacheReadTokens += cached;
					bucket.promptTokens += prompt;
					bucket.completionTokens += completion;
					bucket.cacheReadTokens += cached;
				}
				bucket.lastTs = Math.max(bucket.lastTs, Number(row.ts) || 0);
				reviewer.byModel[lane] = bucket;
			}
		}
		out.avgDecisionMs = counted === 0 ? 0 : Math.round(sum / counted);
		out.reviewer = reviewer;
		return out;
	}

	/** Clears one session only; the watermark keeps a reconcile from rebuilding it. */
	async function clear(opts = {}) {
		await ensureLoaded();
		const session = typeof opts.session === 'string' && opts.session !== '' ? opts.session : undefined;
		if (session === undefined) return { cleared: 0, clearedAt: 0 };
		const list = sessions.get(session);
		const removed = list === undefined ? 0 : list.length;
		sessions.delete(session);
		const stamp = Date.now();
		cleared[session] = stamp;
		await persistEntries();
		return { cleared: removed, clearedAt: stamp };
	}

	/**
	 * How many times this session approved a call touching `path`. Counts `allowed-once`
	 * rows; legacy rows without `filePath` are parsed from their arguments.
	 */
	async function fileCount(sessionId, path) {
		const counts = await fileCounts(sessionId);
		for (const item of counts) if (item.path === path) return item.count;
		return 0;
	}

	/** Every file this session has approved something for, most-approved first. */
	async function fileCounts(sessionId) {
		await ensureLoaded();
		if (typeof sessionId !== 'string' || sessionId === '') return [];
		const floor = clearedAt(sessionId);
		const map = new Map();
		for (const row of rowsOf(sessionId)) {
			if ((Number(row.ts) || 0) <= floor) continue;
			// Human approvals only: the same rule the memory threshold uses, so the file
			// counter and the per-operation counter can never disagree about "learned".
			if (row.outcome !== 'allowed-once' || row.decidedBy !== 'human') continue;
			const path = typeof row.filePath === 'string' && row.filePath !== '' ? row.filePath : filePathOf(row.argsText);
			if (path === '') continue;
			map.set(path, (map.get(path) ?? 0) + 1);
		}
		return [...map.entries()]
			.map(([path, count]) => ({ path, count }))
			.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
	}

	async function memoryRows(session) {
		await ensureLoaded();
		const prefix = typeof session === 'string' && session !== '' ? session + '\u0000' : '';
		const out = [];
		for (const [key, row] of memory) {
			if (prefix !== '' && key.startsWith(prefix) === false) continue;
			// The fingerprint only exists inside the memory key (`sessionId\0fp`), and both
			// removal and the panel's per-row bucketing need it as a field; deriving it on
			// every consumer was how `remove` silently matched nothing and how two unrelated
			// commands ended up in one bucket.
			const cut = key.indexOf('\u0000');
			out.push({ key, fingerprint: cut >= 0 ? key.slice(cut + 1) : '', ...row });
		}
		// Rows written before `filePath` existed only carry `material`, whose path has
		// already been shrunk to its last two segments — a path that no ledger row and no
		// switch key can ever match. Recover the real file from the calls the row still
		// remembers, so one file stays one row and the per-file switch keys something real.
		let byCall = null;
		for (const row of out) {
			if (typeof row.filePath === 'string' && row.filePath !== '') continue;
			if (byCall === null) {
				byCall = new Map();
				for (const entry of rowsOf(session)) {
					const id = typeof entry.callId === 'string' ? entry.callId : '';
					if (id === '' || byCall.has(id) === true) continue;
					const path = typeof entry.filePath === 'string' && entry.filePath !== '' ? entry.filePath : filePathOf(entry.argsText);
					if (path !== '') byCall.set(id, path);
				}
			}
			for (const id of Array.isArray(row.calls) ? row.calls : []) {
				const path = byCall.get(id);
				if (path !== undefined) {
					row.filePath = path;
					break;
				}
			}
		}
		return out.sort((a, b) => (Number(b.lastTs) || 0) - (Number(a.lastTs) || 0));
	}

	/** Human approvals only: the caller decides that, this only counts. */
	async function memoryBump(input) {
		await ensureLoaded();
		const sessionId = String(input?.sessionId ?? '');
		const fp = String(input?.fingerprint ?? '');
		if (sessionId === '' || fp === '') return undefined;
		const key = memoryKey(sessionId, fp);
		const now = Date.now();
		const row = memory.get(key) ?? { toolName: String(input?.toolName ?? ''), summary: String(input?.summary ?? '').slice(0, 240), count: 0, firstTs: now, calls: [] };
		row.count = (Number(row.count) || 0) + 1;
		row.lastTs = now;
		row.toolName = row.toolName || String(input?.toolName ?? '');
		row.summary = String(input?.summary ?? row.summary ?? '').slice(0, 240);
		// Keep the material so a future KNOB_KEYS addition can recompute this count
		// instead of asking the human to teach the same operation again.
		if (typeof input?.material === 'string' && input.material !== '') row.material = input.material.slice(0, 500);
		// Kept so the panel can merge "every edit of this file" without re-parsing.
		if (typeof input?.filePath === 'string' && input.filePath !== '') row.filePath = input.filePath.slice(0, 400);
		if (input?.fpMode === 'normalized' || input?.fpMode === 'exact') row.fpMode = input.fpMode;
		if (Array.isArray(input?.droppedKeys) && input.droppedKeys.length > 0) row.droppedKeys = input.droppedKeys.slice(0, 12);
		if (typeof input?.callId === 'string' && input.callId !== '') {
			row.calls = [input.callId, ...(Array.isArray(row.calls) ? row.calls : [])].slice(0, 10);
		}
		memory.set(key, row);
		await persistMemory();
		return { ...row, key };
	}

	/**
	 * A learned operation passed on its own. The count must not move — only human
	 * approvals may raise it — but the row is still *in use*, and freezing lastTs made
	 * every frequently auto-passing operation sink to the bottom of the memory list.
	 */
	async function memoryTouch(sessionId, fp) {
		await ensureLoaded();
		const key = memoryKey(String(sessionId ?? ''), String(fp ?? ''));
		const row = memory.get(key);
		if (row === undefined) return 0;
		row.lastTs = Date.now();
		await persistMemory();
		return 1;
	}

	async function memoryEntry(sessionId, fp) {
		await ensureLoaded();
		const row = memory.get(memoryKey(sessionId, fp));
		return row === undefined ? undefined : { ...row };
	}

	/** @returns {Promise<number>} rows removed (0 or 1), like every other clear. */
	async function memoryRemove(sessionId, fp) {
		await ensureLoaded();
		const key = memoryKey(sessionId, fp);
		const had = memory.delete(key);
		if (had === false) return 0;
		await persistMemory();
		return 1;
	}

	async function memoryClear(sessionId) {
		await ensureLoaded();
		const prefix = String(sessionId) + '\u0000';
		let removed = 0;
		for (const key of [...memory.keys()]) {
			if (key.startsWith(prefix)) {
				memory.delete(key);
				removed += 1;
			}
		}
		if (removed > 0) await persistMemory();
		return removed;
	}

	function settingsSnapshot() {
		return {
			...settings,
			agentPolicy: { ...settings.agentPolicy },
			hintMs: { ...settings.hintMs },
			reviewerModelLocal: { ...settings.reviewerModelLocal },
		};
	}

	async function writeSettings(patch) {
		await ensureLoaded();
		settings = clampSettings(patch, settings);
		const written = settingsSnapshot();
		await serialize(async () => {
			try {
				await writeAtomic(settingsPath, written);
				degraded = false;
			} catch {
				degraded = true;
			}
		});
		// The probe files only exist for a diagnostic run: switching the switch off should not
		// leave the leftovers behind on the next start.
		if (settings.debugReview !== true) await unlink(join(root, 'review-probe.log')).catch(() => undefined);
		if (settings.debugHeaders !== true) await unlink(join(root, 'http-probe.log')).catch(() => undefined);
		return settingsSnapshot();
	}

	async function health() {
		await ensureLoaded();
		let entries = 0;
		for (const list of sessions.values()) entries += list.length;
		return { path: root, writable: degraded === false, sessions: sessions.size, entries, memory: memory.size };
	}

	return {
		root,
		ensureLoaded,
		record,
		subscribe,
		announce,
		query,
		fileCount,
		fileCounts,
		stats,
		clear,
		memoryRows,
		memoryEntry,
		memoryBump,
		memoryTouch,
		memoryRemove,
		memoryClear,
		settingsSnapshot,
		writeSettings,
		settings: async () => {
			await ensureLoaded();
			return settingsSnapshot();
		},
		health,
	};
}
