/**
 * The hub's HTTP face. Read-only except for settings, memory removal and the
 * gated session clear — the panel never writes files or session events.
 */
import { appendFile, readFile } from 'node:fs/promises';
import { toCsv, toJson, fileName } from './export.js';
import { computeDiff } from './diff.js';
import { splitRoute } from './store.js';

export const ROUTE_PREFIX = '/api/review-hub';
export const ROUTES = Object.freeze({
	health: ROUTE_PREFIX + '/health',
	entries: ROUTE_PREFIX + '/entries',
	stats: ROUTE_PREFIX + '/stats',
	pending: ROUTE_PREFIX + '/pending',
	memory: ROUTE_PREFIX + '/memory',
	config: ROUTE_PREFIX + '/config',
	clear: ROUTE_PREFIX + '/clear',
	diff: ROUTE_PREFIX + '/diff',
	revert: ROUTE_PREFIX + '/revert',
	export: ROUTE_PREFIX + '/export',
	models: ROUTE_PREFIX + '/models',
	files: ROUTE_PREFIX + '/files',
	stream: ROUTE_PREFIX + '/stream',
	probe: ROUTE_PREFIX + '/probe',
});

const CONFIG_FIELDS = [
	'aiEnabled', 'memoryEnabled', 'composerHint', 'pendingCard', 'toastEnabled', 'toastQuietMs',
	'threshold', 'aiFailurePolicy', 'reviewTimeoutMs', 'aiBudgetPerTurn', 'aiBreakerFails',
	'aiCacheTtlMs', 'aiReasonChars', 'reviewerLocale', 'strictVerdict', 'reviewerModel', 'reviewerModelLocal', 'clearEnabled', 'maxEntriesPerSession', 'pollMs',
	'exportScope', 'agentPolicy', 'hintMs', 'fpIgnoreJustification', 'autoExpandDescription', 'hideKnobs', 'snapshotRetentionDays', 'fileAutoPass', 'fileFingerprint', 'aiTools', 'aiToolsDeny', 'aiAdviceCard', 'dangerCard', 'debugHeaders', 'debugReview',
];

function isLoopback(host) {
	if (typeof host !== 'string' || host === '') return false;
	const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
	return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

/**
 * Does the request carry the proof we settled on after the header probe?
 *
 * The rule is data, not code: the probe log tells us which signal the panel sends
 * and curl does not, and `writeProofCookie` / `writeProofHeader` name it. Both
 * empty (the default) means "no proof required" — the gate is off.
 */
export function carriesProof(req, proof) {
	if (proof === undefined || proof === null) return true;
	const cookieName = typeof proof.cookie === 'string' ? proof.cookie : '';
	const headerName = typeof proof.header === 'string' ? proof.header : '';
	if (cookieName === '' && headerName === '') return true;
	const headers = req?.headers ?? {};
	if (cookieName !== '') {
		const cookie = headers.cookie;
		if (typeof cookie !== 'string') return false;
		// Prefix match on purpose: the host mints its cookie as `dsh-auth-<random>`, and
		// that suffix changes with every host start, so an exact name would only work
		// until the next restart. The probe log is what showed this (2026-11-09).
		const hit = cookie.split(';').some((part) => {
			const name = part.split('=')[0].trim();
			return name !== '' && name.startsWith(cookieName);
		});
		if (hit === false) return false;
	}
	if (headerName !== '' && headers[headerName.toLowerCase()] === undefined) return false;
	return true;
}

/** Browser-only fence: loopback host, same-origin Origin, and a browser-set fetch context. */
export function isTrusted(req, options = {}) {
	const host = req?.headers?.host;
	if (isLoopback(host) === false) return false;
	const origin = req?.headers?.origin ?? req?.headers?.referer;
	if (origin !== undefined) {
		try {
			const parsed = new URL(origin);
			if (parsed.protocol === 'dsh-app:') return true;
			return parsed.host === host;
		} catch {
			return false;
		}
	}
	// No Origin at all. EventSource never sends one, so this case has to stay open by
	// default — the desktop shell turned out to send neither Origin nor Sec-Fetch-*, and
	// gating on those bricked the panel (verified on the real host, 2026-11-09).
	//
	// The stricter rule is therefore opt-in: `strictOrigin` accepts only a browser fetch
	// context (Sec-Fetch-Site) and rejects bare clients like curl / PowerShell.
	if (options.strictOrigin === true) {
		const site = req?.headers?.['sec-fetch-site'];
		return site === 'same-origin' || site === 'same-site' || site === 'none';
	}
	// Write methods must carry the proof, once one has been chosen from the probe log.
	// Reads stay open on purpose: EventSource sends neither Origin nor the proof, and a
	// GET from this surface only ever returns JSON the browser will not execute.
	if (options.mode === 'write') return carriesProof(req, options.proof);
	return true;
}

function sendJson(res, code, body) {
	res.statusCode = code;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	res.end(JSON.stringify(body));
}

function sendText(res, code, body, headers = {}) {
	res.statusCode = code;
	for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
	res.end(body);
}

const PROBE_MAX_LINES = 400;

/**
 * Header forensics for the HTTP fence. Records header *names* (plus the cookie names
 * and the fetch-context values, which are what a fence would key on) — never values.
 * Bounded and fire-and-forget: a probe must not be able to break or fill a request.
 */
export function createProbe(file) {
	let written = 0;
	let full = false;
	function note(req, extra = {}) {
		if (full === true) return;
		try {
			const headers = req?.headers ?? {};
			const cookie = typeof headers.cookie === 'string' ? headers.cookie : '';
			if (written === 0) {
				void appendFile(file, '# review-hub http probe — header names and cookie names only\n').catch(() => undefined);
			}
			written += 1;
			if (written > PROBE_MAX_LINES) {
				full = true;
				void appendFile(file, '# probe stopped (line cap reached)\n').catch(() => undefined);
				return;
			}
			const line = JSON.stringify({
				at: Date.now(),
				source: extra.source ?? 'http',
				method: req?.method ?? 'GET',
				url: String(req?.url ?? ''),
				mode: extra.mode,
				headerNames: Object.keys(headers).sort(),
				cookieNames: cookie === '' ? [] : cookie.split(';').map((part) => part.split('=')[0].trim()).filter((name) => name !== ''),
				origin: headers.origin ?? null,
				referer: headers.referer ?? null,
				secFetchSite: headers['sec-fetch-site'] ?? null,
				secFetchMode: headers['sec-fetch-mode'] ?? null,
				userAgent: headers['user-agent'] ?? null,
				report: extra.report,
			});
			void appendFile(file, line + '\n').catch(() => undefined);
		} catch {
			// Forensics is never allowed to be a failure mode of the API.
		}
	}
	return { note, file };
}

async function readBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	const text = Buffer.concat(chunks).toString('utf8');
	if (text.trim() === '') return {};
	return JSON.parse(text);
}

/**
 * The content to diff against, or the reason there is none.
 *
 * The write-ahead snapshot recorded what *this* call wrote (derived from the tool
 * arguments). The file on disk may have moved on since — a later approval rewrote
 * it — so disk is only the fallback, and `drifted` reports that the two disagree.
 */
async function readAfter(entry) {
	const recorded = typeof entry.afterHint === 'string' ? entry.afterHint : undefined;
	let disk;
	try {
		disk = await readFile(entry.path, 'utf8');
	} catch {
		disk = undefined;
	}
	if (recorded !== undefined) return { text: recorded, drifted: disk !== recorded };
	if (disk !== undefined) return { text: disk, drifted: false };
	return { reason: 'no-after' };
}

async function lookupEntry(snapshot, sessionId, callId) {
	if (snapshot === void 0 || snapshot === null) return undefined;
	try {
		return await snapshot.lookup(sessionId, callId);
	} catch {
		return undefined;
	}
}

/**
 * The real diff stats of one recorded call, or undefined when there is nothing to
 * compare. Exported because the answerer stores these on the row once, instead of
 * every panel render paying two file reads per row.
 * @returns {Promise<{add:number, del:number} | undefined>}
 */
export async function diffStatsFor(snapshot, sessionId, callId) {
	if (typeof sessionId !== 'string' || sessionId === '' || typeof callId !== 'string' || callId === '') return undefined;
	const entry = await lookupEntry(snapshot, sessionId, callId);
	if (entry === undefined || entry.tooLarge === true) return undefined;
	const after = await readAfter(entry);
	if (typeof after.text !== 'string') return undefined;
	const result = computeDiff(typeof entry.before === 'string' ? entry.before : null, after.text);
	if (result.binary === true || result.tooLarge === true) return undefined;
	const stats = result.stats === null || result.stats === undefined ? {} : result.stats;
	return { add: Number(stats.add) || 0, del: Number(stats.del) || 0 };
}

/** Attach `hasSnapshot` to every row; a snapshot failure only hides the flag. */
async function withSnapshotFlags(snapshot, rows) {
	if (snapshot === void 0 || snapshot === null) return rows;
	try {
		if (typeof snapshot.warm === 'function') await snapshot.warm(rows.map((row) => row.sessionId));
		return rows.map((row) => {
			let hasSnapshot = false;
			try {
				hasSnapshot = snapshot.has(row.sessionId, row.callId) === true;
			} catch {
				hasSnapshot = false;
			}
			return { ...row, hasSnapshot };
		});
	} catch {
		return rows.map((row) => ({ ...row, hasSnapshot: false }));
	}
}

/**
 * The user message a revert delivers. `createUserMessage` lives in the host LLM
 * package, so the import is lazy and optional — but the fallback MUST carry an id:
 * a message event without one makes the whole session log unloadable, which is
 * exactly how the previous bridge wiped a session out of the sidebar.
 */
let messageFactory;
let messageFactoryProbed = false;

async function buildUserMessage(text) {
	if (messageFactoryProbed !== true) {
		messageFactoryProbed = true;
		try {
			const mod = await import('@deepseek-ai/dsh-llm/message');
			messageFactory = typeof mod?.createUserMessage === 'function' ? mod.createUserMessage : null;
		} catch {
			messageFactory = null;
		}
	}
	const params = { content: [{ type: 'text', text }], source: { kind: 'user-approval' } };
	if (typeof messageFactory === 'function') {
		try {
			return messageFactory(params);
		} catch {
			/* fall through to the plain shape */
		}
	}
	return { id: crypto.randomUUID(), role: 'user', ...params };
}

/** What the agent is told to do; it writes the file, this plugin never does. */
export function revertInstruction(entry, snapshotPath, callId) {
	const path = entry?.path ?? '';
	const restore = typeof entry?.before === 'string'
		? '把该文件的内容整体改回快照条目里的 before 字段（即改动前的原文）。'
		: '改动前该文件不存在，请把它删除。';
	return [
		'请依据写前快照，把下面这个文件恢复到本次改动之前的状态，并用工具真正写回磁盘（不要只在回答里贴内容）。',
		'文件路径：' + path,
		'快照文件：' + snapshotPath,
		'快照条目：entries[' + JSON.stringify(String(callId)) + ']',
		restore,
		'除该文件外不要改动其它文件。',
	].join('\n');
}

function project(settings) {
	const out = {};
	for (const field of CONFIG_FIELDS) out[field] = settings?.[field];
	return out;
}

/**
 * The lane the *next* approval in this session would use, for the panel's
 * "实际会用哪条" line.
 *
 * Same order as `routeOf()` in ./src/index.js — the session's own pin (key presence
 * decides, and `''` never falls back to the global pin) -> the global pin -> this
 * session's own lane. `routeOf` needs the request, so this resolver reads the
 * session lane from the catalog instead; the two MUST stay in step. The cut itself
 * is shared with `splitRoute()` (./store.js), so only the order is duplicated here.
 */
function nextRouteOf(settings, session, providers, sessionLane) {
	const local = settings?.reviewerModelLocal;
	const key = typeof session === 'string' ? session : '';
	let pinned = '';
	if (local !== null && typeof local === 'object' && Object.prototype.hasOwnProperty.call(local, key)) {
		pinned = typeof local[key] === 'string' ? local[key] : '';
	} else {
		pinned = typeof settings?.reviewerModel === 'string' ? settings.reviewerModel : '';
	}
	const cut = splitRoute(pinned, providers.map((provider) => provider.id));
	return cut === undefined ? sessionLane : cut;
}

/**
 * The /models contract, applied to whatever the catalog produced: every field is
 * always present with its empty value, so the panel never has to guess a shape.
 * `models` is the observed-lane alias it has always been; `next` is the lane the
 * next approval would use (the session pin included) and `current` stays the lane
 * the session's last real request ran on.
 */
function modelView(catalog, settings, session) {
	const providers = [];
	for (const provider of Array.isArray(catalog?.providers) ? catalog.providers : []) {
		const id = typeof provider?.id === 'string' ? provider.id : '';
		if (id === '') continue;
		const name = typeof provider?.name === 'string' && provider.name !== '' ? provider.name : id;
		const models = [];
		for (const model of Array.isArray(provider?.models) ? provider.models : []) {
			const modelId = typeof model?.id === 'string' ? model.id : '';
			if (modelId === '') continue;
			models.push({ id: modelId, name: typeof model?.name === 'string' && model.name !== '' ? model.name : modelId });
		}
		providers.push({ id, name, models });
	}
	const observed = (Array.isArray(catalog?.observed) ? catalog.observed : []).filter((lane) => typeof lane === 'string' && lane !== '');
	const errors = (Array.isArray(catalog?.errors) ? catalog.errors : []).map((error) => ({
		provider: typeof error?.provider === 'string' ? error.provider : '',
		code: typeof error?.code === 'string' ? error.code : '',
	}));
	const current = typeof catalog?.current?.provider === 'string' && catalog.current.provider !== ''
		&& typeof catalog?.current?.model === 'string' && catalog.current.model !== ''
		? { provider: catalog.current.provider, model: catalog.current.model }
		: null;
	const fetchedAt = Number.isFinite(Number(catalog?.fetchedAt)) && Number(catalog.fetchedAt) > 0 ? Number(catalog.fetchedAt) : 0;
	return { providers, observed, models: observed, current, errors, fetchedAt, next: nextRouteOf(settings, session, providers, current) };
}

/**
 * @param {object} deps - store, pendingView(), answererState(), version.
 * @returns {Array<{kind:'exact', path:string, handler:Function}>}
 */
export function createRoutes(deps) {
	const store = deps.store;
	const probe = typeof deps.probeFile === 'string' && deps.probeFile !== '' ? createProbe(deps.probeFile) : undefined;
	// The probe is a setting now, so it can be flipped from the panel without a restart:
	// the log file only grows while it is on, and turning it off leaves the old log as-is.
	const probeOn = () => (typeof deps.debugHeaders === 'function' ? deps.debugHeaders() === true : deps.debugHeaders === true);
	const settings = () => (typeof deps.settings === 'function' ? deps.settings() : {});
	const pendingView = typeof deps.pendingView === 'function' ? deps.pendingView : () => [];

	const guard = (handler, methods) => async (req, res) => {
		try {
			const method = req?.method ?? 'GET';
			// The fence keys on the verb, not the route: /memory and /config are both
			// readable and writable, so "this route is a GET route" would let their POST
			// halves through.
			const mode = method === 'GET' || method === 'HEAD' ? 'read' : 'write';
			if (probeOn() === true) probe?.note(req, { mode });
			if (isTrusted(req, { strictOrigin: deps.strictOrigin === true, mode, proof: deps.proof }) === false) {
				probe?.note(req, { mode, denied: 'fence' });
				sendJson(res, 403, { error: 'forbidden' });
				return;
			}
			if (methods.includes(req?.method ?? 'GET') === false) {
				sendJson(res, 405, { error: 'method not allowed' });
				return;
			}
			await handler(req, res);
		} catch {
			if (res.writableEnded !== true) sendJson(res, 500, { error: 'internal' });
		}
	};

	const urlOf = (req) => new URL(req?.url ?? '/', 'http://localhost');

	const routes = [
		{
			kind: 'exact',
			path: ROUTES.health,
			handler: guard(async (_req, res) => {
				sendJson(res, 200, {
					ok: true,
					version: deps.version ?? '',
					answerer: deps.answererState?.() ?? {},
					pending: pendingView().length,
					store: await store.health(),
					settings: project(settings()),
				});
			}, ['GET', 'HEAD']),
		},
		{
			kind: 'exact',
			path: ROUTES.entries,
			handler: guard(async (req, res) => {
				const url = urlOf(req);
				const session = url.searchParams.get('session') ?? undefined;
				const since = Number(url.searchParams.get('since'));
				const limit = Number(url.searchParams.get('limit'));
				const result = await store.query({ session, since: Number.isFinite(since) ? since : 0, limit: Number.isFinite(limit) ? limit : undefined });
				sendJson(res, 200, { ...result, entries: await withSnapshotFlags(deps.snapshot, result.entries) });
			}, ['GET', 'HEAD']),
		},
		{
			kind: 'exact',
			path: ROUTES.stats,
			handler: guard(async (req, res) => {
				const tally = await store.stats({ session: urlOf(req).searchParams.get('session') ?? undefined });
				// The lane breakdown rides along so the panel can show "which reviewer
				// allowed what" without a second request. Row-derived numbers win: they cover
				// every call this session ever made, while the live counters start again with
				// each host boot. Live still contributes what rows cannot know (cache size,
				// breaker state, whether the model takes maxTokens).
				const live = deps.answererState?.()?.reviewer;
				sendJson(res, 200, { ...tally, reviewer: live === undefined ? tally.reviewer : { ...live, ...tally.reviewer } });
			}, ['GET', 'HEAD']),
		},
		{
			kind: 'exact',
			path: ROUTES.models,
			handler: guard(async (req, res) => {
				const url = urlOf(req);
				const session = url.searchParams.get('session') ?? undefined;
				const refresh = url.searchParams.get('refresh') === '1';
				// A broken or absent catalog is a UI state, never a transport failure: the
				// panel shows "no catalog" instead of a network error.
				let catalog;
				try {
					catalog = typeof deps.modelCatalog === 'function' ? await deps.modelCatalog(session, { refresh }) : undefined;
				} catch {
					catalog = undefined;
				}
				// `catalog.current` is the session's *chat* lane (its last request header),
				// which exists even before this session ever asked for an approval. The
				// panel's "上次审批" line must come from the ledger instead, so it is empty
				// until something was actually approved.
				let lastApproval = null;
				if (typeof session === 'string' && session !== '') {
					try {
						const rows = await store.query({ session, limit: 50 });
						for (const row of rows.entries) {
							if (typeof row.routeModel === 'string' && row.routeModel !== '') {
								lastApproval = row.routeModel;
								break;
							}
						}
					} catch {
						lastApproval = null;
					}
				}
				sendJson(res, 200, { ...modelView(catalog, settings(), session), lastApproval });
			}, ['GET', 'HEAD']),
		},
		{
			// Server-sent events: a row reaches the page the moment it is written instead
			// of on the next poll. The host's gzip middleware skips text/event-stream,
			// and nothing in the webserver times a response out.
			kind: 'exact',
			path: ROUTES.stream,
			handler: guard(async (req, res) => {
				const session = urlOf(req).searchParams.get('session') ?? '';
				if (session === '') {
					sendJson(res, 200, { ok: false, reason: 'bad-request' });
					return;
				}
				res.writeHead(200, {
					'content-type': 'text/event-stream; charset=utf-8',
					'cache-control': 'no-cache, no-transform',
					connection: 'keep-alive',
					'x-accel-buffering': 'no',
				});
				// Honor backpressure: a client that stops reading must not grow the
				// host's buffer without bound. Heartbeats are the first thing dropped.
				let writable = true;
				res.on('drain', () => { writable = true; });
				const write = (chunk) => {
					if (writable !== true) return false;
					try {
						writable = res.write(chunk);
					} catch {
						writable = false;
					}
					return writable;
				};
				const frame = (event, payload) => write('event: ' + event + '\ndata: ' + JSON.stringify(payload) + '\n\n');
				const pendingFor = () => pendingView().filter((row) => row.sessionId === session);
				/** Other sessions' waiting requests, aggregated: counts only, never content. */
				const pendingOthers = () => {
					const bySession = new Map();
					for (const row of pendingView()) {
						if (row.sessionId === session) continue;
						const entry = bySession.get(row.sessionId) ?? {
							sessionId: row.sessionId,
							title: typeof deps.titleFor === 'function' ? deps.titleFor(row.sessionId) : '',
							count: 0,
							oldest: 0,
						};
						entry.count += 1;
						const started = Number(row.startedAt) || 0;
						if (started > 0 && (entry.oldest === 0 || started < entry.oldest)) entry.oldest = started;
						bySession.set(row.sessionId, entry);
					}
					return [...bySession.values()];
				};
				write('retry: 3000\n\n');
				frame('ready', { session });
				frame('pending', { pending: pendingFor(), others: pendingOthers() });
				// Bursts land as ONE frame: a batch of approvals used to mean one frame
				// each, and one render each. Rows are serialized once here, then shared.
				let entryQueue = [];
				let pendingQueued = false;
				let flushTimer = null;
				const flush = () => {
					flushTimer = null;
					if (entryQueue.length > 0) {
						const rows = entryQueue;
						entryQueue = [];
						write('event: entries\ndata: {"rows":[' + rows.join(',') + ']}\n\n');
					}
					if (pendingQueued === true) {
						pendingQueued = false;
						frame('pending', { pending: pendingFor(), others: pendingOthers() });
					}
				};
				const queueFlush = () => {
					if (flushTimer !== null) return;
					flushTimer = setTimeout(flush, 120);
					if (typeof flushTimer?.unref === 'function') flushTimer.unref();
				};
				const unsubscribe = typeof store.subscribe === 'function'
					? store.subscribe((event) => {
						if (event?.kind === 'pending') {
							pendingQueued = true;
							queueFlush();
							return;
						}
						if (event?.kind !== 'entry' || event.row === undefined) return;
						const row = event.row;
						if (row.sessionId === session) {
							entryQueue.push(JSON.stringify(row));
							queueFlush();
							return;
						}
						// Another session: only what the aggregate row needs, never its content.
						frame('other', {
							sessionId: row.sessionId,
							id: row.id,
							ts: row.ts,
							decidedBy: row.decidedBy,
							outcome: row.outcome,
							toolName: row.toolName,
							title: typeof deps.titleFor === 'function' ? deps.titleFor(row.sessionId) : '',
						});
					})
					: () => {};
				const beat = setInterval(() => write(': ping\n\n'), 30000);
				if (typeof beat?.unref === 'function') beat.unref();
				const close = () => {
					clearInterval(beat);
					if (flushTimer !== null) clearTimeout(flushTimer);
					unsubscribe();
					try {
						res.end();
					} catch {
						/* already finished */
					}
				};
				req.on('close', close);
				req.on('error', close);
			}, ['GET']),
		},
		{
			kind: 'exact',
			path: ROUTES.pending,
			handler: guard(async (req, res) => {
				const session = urlOf(req).searchParams.get('session') ?? '';
				const list = pendingView().filter((row) => session === '' || row.sessionId === session);
				sendJson(res, 200, { pending: list });
			}, ['GET', 'HEAD']),
		},
		{
			kind: 'exact',
			path: ROUTES.memory,
			handler: guard(async (req, res) => {
				const current = settings();
				if (req.method !== 'POST') {
					const session = urlOf(req).searchParams.get('session') ?? undefined;
					sendJson(res, 200, { threshold: current.threshold, entries: await store.memoryRows(session) });
					return;
				}
				const body = await readBody(req);
				const session = typeof body?.session === 'string' && body.session !== '' ? body.session : '';
				if (session === '') {
					sendJson(res, 400, { error: 'session required' });
					return;
				}
				if (body?.op === 'clear') {
					const removed = await store.memoryClear(session);
					sendJson(res, 200, { ok: true, removed, threshold: current.threshold, entries: await store.memoryRows(session) });
					return;
				}
				if (body?.op === 'remove' && typeof body?.fingerprint === 'string') {
					const removed = await store.memoryRemove(session, body.fingerprint);
					sendJson(res, 200, { ok: true, removed, threshold: current.threshold, entries: await store.memoryRows(session) });
					return;
				}
				sendJson(res, 400, { error: 'bad op' });
			}, ['GET', 'HEAD', 'POST']),
		},
		{
			// Files this session has approved calls for, plus whether each one may auto-pass.
			kind: 'exact',
			path: ROUTES.files,
			handler: guard(async (req, res) => {
				const session = urlOf(req).searchParams.get('session') ?? '';
				if (session === '') {
					sendJson(res, 200, { files: [] });
					return;
				}
				const current = settings();
				const armed = current.fileAutoPass !== null && typeof current.fileAutoPass === 'object' ? current.fileAutoPass : {};
				const rows = await store.fileCounts(session);
				sendJson(res, 200, {
					threshold: Number(current.threshold) || 3,
					files: rows.map((row) => ({
						path: row.path,
						count: row.count,
						auto: armed[session + '\u0000' + row.path] === true,
					})),
				});
			}, ['GET', 'HEAD']),
		},
		{
			kind: 'exact',
			path: ROUTES.config,
			handler: guard(async (req, res) => {
				if (req.method !== 'POST') {
					sendJson(res, 200, project(settings()));
					return;
				}
				const body = await readBody(req);
				const written = await store.writeSettings(body);
				sendJson(res, 200, project(written));
			}, ['GET', 'HEAD', 'POST']),
		},
		{
			kind: 'exact',
			path: ROUTES.clear,
			handler: guard(async (req, res) => {
				// Hiding the button is not the gate: the route refuses while the switch is off.
				if (settings().clearEnabled !== true) {
					sendJson(res, 403, { error: 'clear disabled' });
					return;
				}
				const body = await readBody(req);
				const session = typeof body?.session === 'string' && body.session !== '' ? body.session : '';
				if (session === '') {
					// Session scope only: this plugin never wipes another session's history.
					sendJson(res, 400, { error: 'session required' });
					return;
				}
				sendJson(res, 200, await store.clear({ session }));
			}, ['POST']),
		},
		{
			kind: 'exact',
			path: ROUTES.diff,
			handler: guard(async (req, res) => {
				const url = urlOf(req);
				const session = url.searchParams.get('session') ?? '';
				const callId = url.searchParams.get('callId') ?? '';
				if (session === '' || callId === '') {
					// A shape error is the panel's bug, not a transport failure: answer 200 so
					// the client renders its "no diff" state instead of a network error.
					sendJson(res, 200, { ok: false, reason: 'bad-request' });
					return;
				}
				const entry = await lookupEntry(deps.snapshot, session, callId);
				if (entry === undefined) {
					sendJson(res, 200, { ok: false, reason: 'no-snapshot' });
					return;
				}
				if (entry.tooLarge === true) {
					sendJson(res, 200, { ok: false, reason: 'too-large' });
					return;
				}
				const after = await readAfter(entry);
				if (typeof after.text !== 'string') {
					sendJson(res, 200, { ok: false, reason: after.reason });
					return;
				}
				const result = computeDiff(typeof entry.before === 'string' ? entry.before : null, after.text);
				if (result.binary === true) {
					sendJson(res, 200, { ok: false, reason: 'binary' });
					return;
				}
				if (result.tooLarge === true) {
					sendJson(res, 200, { ok: false, reason: 'too-large' });
					return;
				}
				sendJson(res, 200, { ok: true, path: entry.path, stats: result.stats, hunks: result.hunks, drifted: after.drifted === true });
			}, ['GET', 'HEAD']),
		},
		{
			kind: 'exact',
			path: ROUTES.revert,
			handler: guard(async (req, res) => {
				const body = await readBody(req);
				const session = typeof body?.session === 'string' ? body.session : '';
				const callId = typeof body?.callId === 'string' ? body.callId : '';
				if (session === '' || callId === '') {
					sendJson(res, 200, { ok: false, reason: 'bad-request' });
					return;
				}
				const snapshot = deps.snapshot;
				const entry = await lookupEntry(snapshot, session, callId);
				if (entry === undefined) {
					sendJson(res, 200, { ok: false, reason: 'no-snapshot' });
					return;
				}
				const snapshotPath = typeof snapshot?.snapshotPath === 'function' ? snapshot.snapshotPath(session) : '';
				let delivered = false;
				try {
					const agentFor = deps.agentFor;
					if (typeof agentFor === 'function') {
						const agent = agentFor(session);
						if (agent !== null && agent !== void 0 && typeof agent.inject === 'function') {
							await agent.inject(await buildUserMessage(revertInstruction(entry, snapshotPath, callId)));
							delivered = true;
						}
					}
				} catch {
					// Delivery failed: the panel shows the same state as an absent agent.
					delivered = false;
				}
				sendJson(res, 200, delivered ? { ok: true, delivered: 'message' } : { ok: false, reason: 'no-agent' });
			}, ['POST']),
		},
		{
			kind: 'exact',
			path: ROUTES.export,
			handler: guard(async (req, res) => {
				const url = urlOf(req);
				const format = url.searchParams.get('format') === 'json' ? 'json' : 'csv';
				const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'session';
				const session = url.searchParams.get('session') ?? '';
				if (scope === 'session' && session === '') {
					sendJson(res, 400, { error: 'session required' });
					return;
				}
				if (scope === 'all' && settings().exportScope !== 'all') {
					sendJson(res, 403, { error: 'export scope locked to session' });
					return;
				}
				const rows = (await store.query({ session: scope === 'all' ? undefined : session, limit: 5000 })).entries;
				const sessionTitle = scope === 'session' && typeof deps.titleFor === 'function' ? deps.titleFor(session) : '';
				const name = fileName(scope, format, sessionTitle);
				const body = format === 'json' ? toJson(rows) : toCsv(rows);
				sendText(res, 200, body, {
					'content-type': format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
					// A CJK title cannot travel in a latin1 header: keep an ASCII fallback and
					// carry the real name in the RFC 5987 form the client decodes.
					'content-disposition': 'attachment; filename="' + name.replace(/[^\x20-\x7e]+/g, '_') + '"; filename*=UTF-8\'\'' + encodeURIComponent(name),
					'cache-control': 'no-store',
				});
			}, ['GET', 'HEAD']),
		},
	];

	if (probe !== undefined) {
		routes.push({
			kind: 'exact',
			path: ROUTES.probe,
			handler: guard(async (req, res) => {
				if (req.method !== 'POST') {
					sendJson(res, 405, { error: 'method not allowed' });
					return;
				}
				let report;
				try {
					report = await readBody(req);
				} catch {
					report = undefined;
				}
				if (probeOn() === true) probe.note({ method: 'POST', url: ROUTES.probe, headers: {} }, { source: 'client', report: clipReport(report) });
				sendJson(res, 200, { ok: true });
			}, ['POST']),
		});
	}

	return routes;
}

/** The panel's self-report is untrusted input: keep only the handful of fields we read. */
function clipReport(report) {
	if (report === null || typeof report !== 'object') return null;
	const names = (value, cap) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string').slice(0, cap) : []);
	return {
		origin: typeof report.origin === 'string' ? report.origin.slice(0, 120) : null,
		cookieNames: names(report.cookieNames, 20),
		globals: names(report.globals, 20),
	};
}

export function registerRoutes(server, deps) {
	if (server === null || typeof server !== 'object' || typeof server.register !== 'function') return [];
	const offs = [];
	for (const route of createRoutes(deps)) {
		try {
			const off = server.register(route);
			if (typeof off === 'function') offs.push(off);
		} catch (error) {
			console.warn('review-hub: route failed ' + route.path + ': ' + (error instanceof Error ? error.message : String(error)));
		}
	}
	return offs;
}
