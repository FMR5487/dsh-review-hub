/**
 * dsh-review-hub — Host half.
 *
 * One answerer on the `approval/request` waterfall. Because this plugin is the
 * only place that may decide, `decidedBy` is recorded as a fact:
 *   memory   -> this plugin let a learned operation through
 *   ai       -> this plugin's reviewer let it through (P2)
 *   human    -> we delegated and the chain-terminal client prompt answered
 *   external -> we delegated and something else answered before the human did
 *   fallback -> the chain produced no grant
 *
 * Hard rules: never append session events, never throw into the chain, and always
 * `return next()` when we do not decide — otherwise the human prompt never sees
 * the request and it fails closed as unavailable.
 */
import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createStore, fileFingerprintOf, filePathOf, fingerprintOf, splitRoute } from './store.js';
import { diffStatsFor } from './routes.js';
import { classify, DEFAULT_TOOLS_POLICY, toolsPolicyOf } from './policy.js';
import { classifyAgent, clampByAgent } from './agentPolicy.js';
import { evidenceFor, eventsOf } from './evidence.js';
import { createReviewer } from './review.js';
import { createSnapshot } from './snapshot.js';
import { createCatalog } from './catalog.js';
import { registerRoutes } from './routes.js';

export const name = 'review-hub';
export const inject = ['approval'];

/** Read once from package.json: a hand-maintained constant always drifts. */
const VERSION = (function () {
	try {
		const pkg = createRequire(import.meta.url)('../package.json');
		return typeof pkg?.version === 'string' && pkg.version !== '' ? pkg.version : '0.0.0';
	} catch {
		return '0.0.0';
	}
})();
/** The longest command text a row keeps; past this the row says it was cut. */
const ARGS_TEXT_MAX = 4000;
/** A human click cannot arrive this fast; anything faster came from another answerer. */
const HUMAN_MIN_MS = 300;

let activeStore;
let activeReviewer;
let activeSnapshot;
let agentsService;
/** Resolved lazily: `llm` is an optional service and must not gate the mount. */
let llmService;
/** The context read behind getLlm(): installed by apply(), dropped on teardown. */
let llmAccessor;
/**
 * Provider ids the host knows, cached because parsing a pinned `reviewerModel`
 * only needs the id set. A provider id may itself contain a '/', so the list is
 * what decides where the pinned route is cut.
 */
const PROVIDER_IDS_TTL_MS = 30000;
let llmProviderIds = [];
let llmProviderIdsAt = 0;
let answererRegistered = false;
let routeCount = 0;
const pending = new Map();
const counters = { asked: 0, memory: 0, ai: 0, human: 0, external: 0, fallback: 0 };
/**
 * Provider/model lanes this plugin has actually seen a turn use. The settings
 * menu offers these instead of guessing a catalog: a route no session ever
 * opened cannot be verified, and a hand-typed one silently degrades.
 */
const observedRoutes = new Set();

export function observedReviewRoutes() {
	return [...observedRoutes];
}

function sessionOf(request) {
	const id = request?.agent?.id;
	return id === undefined || id === null ? '' : String(id);
}

function syncSettings() {
	return activeStore === undefined ? {} : activeStore.settingsSnapshot();
}

/** The pending map is what the composer hint polls; it must not outlive a request. */
function pendingRow(request, id, started, extra) {
	const row = {
		id,
		startedAt: started,
		sessionId: sessionOf(request),
		toolName: typeof request?.toolName === 'string' ? request.toolName : '',
	};
	if (typeof request?.callId === 'string' && request.callId !== '') row.callId = request.callId;
	if (typeof request?.reason === 'string') row.reason = request.reason.slice(0, 240);
	if (extra?.argsSummary !== undefined) row.argsSummary = extra.argsSummary;
	row.riskLevel = extra?.riskLevel ?? 'unknown';
	if (extra?.riskRule !== undefined) row.riskRule = extra.riskRule;
	return row;
}

/** The provider/model of the requesting turn, from the session's own request headers. */
export function latestRoute(session) {
	try {
		const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : session?.events;
		if (Array.isArray(events) === false) return undefined;
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const event = events[index];
			if (event?.type !== 'request/header') continue;
			const config = event.data?.header?.config;
			const provider = config?.provider;
			const model = config?.model;
			if (typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== '') return { provider, model };
		}
	} catch {
		/* a session without events simply has no route */
	}
	return undefined;
}

/**
 * The human-facing name of a session.
 *
 * A session's title is not a property — the host records it as a `session/title` event
 * in the session log (`{"type":"session/title","data":{"title":"装插件"}}`), so the only
 * reliable read is the event list, the same way `latestRoute()` reads the request lane.
 * Field probes stay first because they are free when a version does expose one.
 */
export function titleOfSession(agent) {
	try {
		const session = agent?.session;
		const candidates = [
			session?.title, session?.name, session?.meta?.title, session?.meta?.name,
			session?.descriptor?.title, session?.descriptor?.name,
			session?.header?.title, session?.displayName,
			agent?.title, agent?.name, agent?.meta?.title,
		];
		for (const candidate of candidates) {
			if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim().slice(0, 80);
		}
		const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : session?.events;
		if (Array.isArray(events) === false) return '';
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const event = events[index];
			if (event?.type !== 'session/title') continue;
			const title = event.data?.title;
			if (typeof title === 'string' && title.trim() !== '') return title.trim().slice(0, 80);
		}
	} catch {
		/* an unreadable session falls back to the id tail on the client */
	}
	return '';
}

/** The `llm` service, feature-detected: absent, undeclared and throwing are the same state. */
function getLlm() {
	if (llmService !== undefined) return llmService;
	try {
		return llmAccessor === undefined ? undefined : llmAccessor();
	} catch {
		return undefined;
	}
}

/** Provider ids from the host catalog, cached: `listProviders` is not free. */
function cachedProviderIds() {
	const now = Date.now();
	if (llmProviderIds.length > 0 && now - llmProviderIdsAt < PROVIDER_IDS_TTL_MS) return llmProviderIds;
	const ids = [];
	try {
		const llm = getLlm();
		if (llm !== null && llm !== void 0 && typeof llm.listProviders === 'function') {
			for (const provider of llm.listProviders() ?? []) {
				const id = typeof provider?.id === 'string' ? provider.id.trim() : '';
				if (id !== '') ids.push(id);
			}
		}
	} catch {
		/* no catalog is a normal state: the observed lanes still name their providers */
	}
	llmProviderIds = ids;
	llmProviderIdsAt = now;
	return ids;
}

/** Catalog ids plus every provider an observed lane proves exists. */
function knownProviderIds() {
	const ids = new Set(cachedProviderIds());
	for (const lane of observedRoutes) {
		const at = lane.indexOf('/');
		if (at > 0) ids.add(lane.slice(0, at));
	}
	return [...ids];
}

/**
 * The lane this approval uses: the session's own pin -> the global pin -> the turn's
 * own route.
 *
 * `settings.reviewerModelLocal` is keyed by session id and the *presence* of the key
 * is the decision: `''` means "follow this session's own lane", so it returns
 * undefined and must never fall back to the global pin. `splitRoute()` (./store.js)
 * cuts the pin; the order below is the same one src/routes.js computes for the
 * panel's `next`, and the two resolvers must stay in step.
 */
export function routeOf(request, settings, providerIds = []) {
	const sessionId = sessionOf(request);
	const local = settings?.reviewerModelLocal;
	if (local !== null && typeof local === 'object' && Object.prototype.hasOwnProperty.call(local, sessionId)) {
		const localPin = typeof local[sessionId] === 'string' ? local[sessionId] : '';
		return localPin.trim() === '' ? undefined : splitRoute(localPin, providerIds);
	}
	const pinned = typeof settings?.reviewerModel === 'string' ? settings.reviewerModel.trim() : '';
	if (pinned !== '') {
		const cut = splitRoute(pinned, providerIds);
		if (cut !== undefined) return cut;
	}
	return latestRoute(request?.agent?.session);
}

/**
 * L3: ask the reviewer, but only for tools whose tier is 'ai'. Anything other
 * than a clean allow returns undefined-or-ask and the human prompt takes over.
 */
async function maybeReview(input) {
	if (activeReviewer === undefined) return undefined;
	if (input.tier !== 'ai') return undefined;
	const settingsNow = input.settings ?? {};
	const localAi = settingsNow.aiEnabledLocal === null || typeof settingsNow.aiEnabledLocal !== 'object' ? {} : settingsNow.aiEnabledLocal;
	const aiOn = Object.prototype.hasOwnProperty.call(localAi, String(input.sessionId ?? '')) ? localAi[String(input.sessionId ?? '')] === true : settingsNow.aiEnabled === true;
	if (aiOn !== true) return undefined;
	let prior = 0;
	if (input.fp !== undefined && input.store !== undefined) {
		const entry = await input.store.memoryEntry(input.sessionId, input.fp).catch(() => undefined);
		prior = entry === undefined ? 0 : Number(entry.count) || 0;
	}
	const route = routeOf(input.request, input.settings, knownProviderIds());
	if (route !== undefined && typeof route.provider === 'string' && typeof route.model === 'string') {
		observedRoutes.add(route.provider + '/' + route.model);
		if (observedRoutes.size > 40) observedRoutes.delete(observedRoutes.values().next().value);
	}
	return activeReviewer.review({
		sessionId: input.sessionId,
		toolName: input.toolName,
		agentKind: input.agentKind,
		reason: input.request?.reason,
		summary: input.evidence?.argsSummary,
		priorApprovals: prior,
		// The verdict cache is shared across sessions on purpose (the same operation
		// in a new session is still the same operation); memory counts stay
		// session-scoped, which is a different mechanism with a different risk.
		cacheKey: input.fp === undefined ? undefined : [String(input.agentKind ?? 'unknown'), String(input.fp)].join('\u0000'),
		route,
	});
}

async function decideMemory(store, sessionId, fp, settings) {
	if (settings?.memoryEnabled !== true || fp === undefined || sessionId === '') return undefined;
	const entry = await store.memoryEntry(sessionId, fp).catch(() => undefined);
	if (entry === undefined) return undefined;
	const count = Number(entry.count) || 0;
	if (count < Math.max(1, Number(settings.threshold) || 3)) return undefined;
	return { entry, count };
}

/**
 * One approval. Records exactly one row, whichever branch answered.
 * @returns the chain's outcome, unchanged.
 */
async function answerer(request, next) {
	if (typeof next !== 'function') return Promise.resolve('unavailable');
	const id = randomUUID();
	const started = Date.now();
	const sessionId = sessionOf(request);
	const toolName = typeof request?.toolName === 'string' ? request.toolName : '';
	const callId = typeof request?.callId === 'string' && request.callId !== '' ? request.callId : undefined;
	const settings = syncSettings();
	const store = activeStore;

	const evidence = evidenceFor(request, eventsOf(request));
	const argsText = typeof evidence.argsText === 'string' ? evidence.argsText : '';
	const fpInfo = argsText === '' || toolName === ''
		? undefined
		: fingerprintOf(toolName, argsText, { ignoreJustification: settings?.fpIgnoreJustification === true });
	const filePath = filePathOf(argsText);
	const fileKey = filePath === '' || sessionId === '' ? '' : sessionId + '\u0000' + filePath;
	// Global file-level mode: "the same file" is the operation. Everything downstream
	// (memory rows, the threshold, the auto-pass) then counts per file instead of per
	// exact edit — which is exactly the trade the switch states.
	const fileMode = settings?.fileFingerprint === true && filePath !== '';
	const fp = fpInfo === undefined ? undefined : (fileMode === true ? fileFingerprintOf(toolName, filePath) : fpInfo.fp);
	const agentKind = classifyAgent(request?.agent);
	const { tier: baseTier, hardRisk } = classify(toolName, argsText, { toolsPolicy: toolsPolicyOf(settings) });
	const tier = clampByAgent(baseTier, agentKind, settings?.agentPolicy);
	// Opt-in per file, and never for a hard-risk call: the switch widens what may
	// auto-pass, it does not disable the deterministic L0 layer.
	const fileArmed = fileKey !== '' && hardRisk === undefined
		&& (settings?.fileFingerprint === true || settings?.fileAutoPass?.[fileKey] === true);
	// Record the lane of every request, not only the ones the reviewer sees: the
	// settings menu is built from real lanes, and an AI-off approval still proves one.
	const lane = routeOf(request, settings, knownProviderIds());
	if (lane !== undefined && typeof lane.provider === 'string' && typeof lane.model === 'string') {
		observedRoutes.add(lane.provider + '/' + lane.model);
		if (observedRoutes.size > 40) observedRoutes.delete(observedRoutes.values().next().value);
	}

	const row = pendingRow(request, id, started, {
		argsSummary: evidence.argsSummary,
		riskLevel: hardRisk === undefined ? 'unknown' : 'high',
		riskRule: hardRisk === undefined ? undefined : hardRisk.rule,
	});
	row.agentKind = agentKind;
	row.tier = tier;
	// Set once the reviewer has answered: the dock/toast waits for it, so the human
	// learns what the AI made of the request at the same moment they are asked.
	row.aiReviewed = tier !== 'ai';
	pending.set(id, row);
	counters.asked += 1;
	activeStore?.announce?.({ kind: 'pending' });

	let outcome = 'unavailable';
	let decidedBy = 'fallback';
	let memoryCount;
	let aiNote;
	try {
		// L2 memory: a repeatable operation the human already approved N times.
		const hit = hardRisk === undefined ? await decideMemory(store, sessionId, fp, settings) : undefined;
		const fileHits = fileArmed === false || store === undefined
			? 0
			: await store.fileCount(sessionId, filePath).catch(() => 0);
		if (hit !== undefined) {
			outcome = 'allowed-once';
			decidedBy = 'memory';
			memoryCount = hit.count;
			counters.memory += 1;
			// The count stays frozen; the row's "last used" does not.
			if (store !== undefined && fp !== undefined) await store.memoryTouch(sessionId, fp).catch(() => 0);
		} else if (fileArmed === true && fileHits >= Math.max(1, Number(settings.threshold) || 3)) {
			// The human opted this file in: count its approvals, not its contents.
			outcome = 'allowed-once';
			decidedBy = 'memory';
			memoryCount = fileHits;
			row.note = 'file-auto-pass';
			counters.memory += 1;
		} else {
			const verdict = await maybeReview({ store, sessionId, toolName, agentKind, tier, settings, request, evidence, fp });
			if (verdict !== undefined) {
				aiNote = { risk: verdict.risk, reason: verdict.reason, source: verdict.source, asked: verdict.decision !== 'allow', model: verdict.lane, usage: verdict.usage };
			}
			row.aiReviewed = true;
			if (aiNote !== undefined) {
				row.aiRisk = aiNote.risk;
				// Only a real verdict carries an advice line. "reviewer reply was not a
				// verdict" and friends are diagnostics (aiSource says which), not something
				// a human should read as the AI's opinion.
				if ((aiNote.source === 'ai' || aiNote.source === 'cache') && typeof aiNote.reason === 'string' && aiNote.reason !== '') row.aiReason = aiNote.reason.slice(0, 160);
			}
			// The card is already on screen: push the advice into it the moment it exists.
			activeStore?.announce?.({ kind: 'pending' });
			if (verdict !== undefined && verdict.decision === 'allow') {
				outcome = 'allowed-once';
				decidedBy = 'ai';
				counters.ai += 1;
			} else {
				const chainOutcome = await next();
				const elapsed = Date.now() - started;
				outcome = typeof chainOutcome === 'string' ? chainOutcome : 'unavailable';
				if (outcome === 'unavailable' || outcome === 'cancelled') decidedBy = 'fallback';
				else decidedBy = elapsed < HUMAN_MIN_MS ? 'external' : 'human';
				counters[decidedBy] += 1;
			}
			// Only a human approval teaches memory: AI and memory passes must never
			// compound into a rule nobody ever agreed to.
			if (decidedBy === 'human' && outcome === 'allowed-once' && hardRisk === undefined && fp !== undefined && settings?.memoryEnabled === true && store !== undefined) {
				const bumped = await store.memoryBump({
					sessionId,
					fingerprint: fp,
					toolName,
					summary: evidence.argsSummary ?? '',
					callId,
					material: fpInfo?.material,
					filePath: filePath === '' ? undefined : filePath,
					fpMode: fpInfo?.mode,
					droppedKeys: fpInfo?.droppedKeys,
				}).catch(() => undefined);
				// The count travels with the row so the panel can show "记忆 2/3 次" on a
				// human approval without a second request per row.
				if (bumped !== undefined && Number.isFinite(Number(bumped.count))) memoryCount = Number(bumped.count);
			}
		}
	} catch (error) {
		// A throwing answerer elsewhere must not cost us the row.
		outcome = 'unavailable';
		decidedBy = 'fallback';
		row.note = 'chain-threw: ' + (error instanceof Error ? error.message : String(error)).slice(0, 120);
		counters.fallback += 1;
	} finally {
		pending.delete(id);
		activeStore?.announce?.({ kind: 'pending' });
	}

	const finished = {
		id,
		ts: started,
		sessionId,
		toolName,
		outcome,
		decidedBy,
		decisionMs: Date.now() - started,
		riskLevel: hardRisk === undefined ? 'unknown' : 'high',
	};
	if (callId !== undefined) finished.callId = callId;
	// The lane this decision was resolved against (memory/human rows included): the
	// panel decides what to show, the row just records the fact.
	if (lane !== undefined && typeof lane.provider === 'string' && typeof lane.model === 'string') finished.routeModel = lane.provider + '/' + lane.model;
	if (hardRisk !== undefined) finished.riskRule = hardRisk.rule;
	// Who asked, and what that made the row eligible for. Without these two fields the
	// ledger cannot answer "why did the AI never look at this?", which is exactly the
	// question a human asks when the pass history looks silent.
	finished.agentKind = agentKind;
	finished.tier = tier;
	// The one case that silently costs a review: the tool was AI-eligible but the
	// requester kind clamped it to a human decision.
	if (baseTier === 'ai' && tier !== 'ai') finished.clampedBy = 'agent:' + agentKind;
	if (evidence.argsSummary !== undefined) finished.argsSummary = evidence.argsSummary;
	if (evidence.argsTruncated === true) finished.argsTruncated = true;
	// The whole command, not just its summary: the panel shows every line of what was
	// approved, and a tooltip that only repeats the reason is useless for one.
	if (argsText !== '') {
		finished.argsText = argsText.length > ARGS_TEXT_MAX ? argsText.slice(0, ARGS_TEXT_MAX) : argsText;
		if (argsText.length > ARGS_TEXT_MAX) finished.argsTextTruncated = true;
	}
	if (filePath !== '') finished.filePath = filePath;
	// The threshold this decision was actually judged against: raising the setting later
	// must not rewrite what an already-recorded row says about itself.
	finished.threshold = Math.max(1, Number(settings?.threshold) || 3);
	if (typeof request?.reason === 'string') finished.reason = request.reason.slice(0, 240);
	if (memoryCount !== undefined) finished.memoryCount = memoryCount;
	// Visible merge evidence: the panel says "同类合并" only when a knob was cut.
	if (fpInfo !== undefined && fpInfo.mode === 'normalized') {
		finished.fpMode = 'normalized';
		if (Array.isArray(fpInfo.droppedKeys) && fpInfo.droppedKeys.length > 0) finished.droppedKeys = fpInfo.droppedKeys.slice(0, 12);
	}
	if (row.note !== undefined) finished.note = row.note;
	if (aiNote !== undefined) {
		finished.riskLevel = aiNote.risk;
		finished.aiSource = aiNote.source;
		// Which lane judged it: a pinned reviewer can differ from the session's own lane.
		if (typeof aiNote.model === 'string' && aiNote.model !== '') finished.aiModel = aiNote.model;
		// A cached verdict is the same verdict, so it carries the same reason; dropping it
		// left every cache-served escalation with nothing to show under "AI 打回理由".
		if ((aiNote.source === 'ai' || aiNote.source === 'cache') && typeof aiNote.reason === 'string' && aiNote.reason !== '') finished.aiReason = aiNote.reason;
		if (aiNote.usage !== undefined) finished.aiUsage = aiNote.usage;
	}
	if (store !== undefined) await store.record(finished).catch(() => undefined);

	// The panel's "+N −N" should be the same number its diff page shows. Computing
	// it here costs one snapshot read per written row; the row then carries it, so a
	// list render never touches the disk again.
	if (store !== undefined && callId !== undefined && filePath !== '' && typeof activeSnapshot === 'object' && activeSnapshot !== null) {
		void diffStatsFor(activeSnapshot, sessionId, callId).then(function (stats) {
			if (stats === undefined) return undefined;
			return store.record({ id, sessionId, callId, fileDelta: stats }).catch(() => undefined);
		}).catch(() => undefined);
	}

	return outcome;
}

export function apply(ctx, rawConfig = {}) {
	const debugHeaders = rawConfig?.debugHeaders === true;
	if (rawConfig?.log === true) console.log('review-hub: mounting ' + VERSION);
	if (debugHeaders === true) console.log('review-hub: header probe forced ON by config → http-probe.log');
	const root = typeof rawConfig?.root === 'string' ? rawConfig.root : undefined;
	const store = createStore({ root });
	const snapshot = createSnapshot({ root });
	activeStore = store;
	activeSnapshot = snapshot;
	store.ensureLoaded().catch(() => undefined);

	// The write-ahead snapshot rides the tool waterfall — the only place the
	// before-content still exists. It observes and never decides: every branch must
	// return `next()`, or a capture would start blocking tool calls.
	ctx.effect(() => {
		const listener = (exec, next) => {
			try {
				snapshot.capture(exec);
			} catch {
				// A capture failure means "no diff for this row", never a blocked tool.
			}
			return next();
		};
		try {
			return ctx.on('tools/pre-execute', listener, { prepend: true });
		} catch (error) {
			console.warn('review-hub: pre-execute hook unavailable: ' + (error instanceof Error ? error.message : String(error)));
			return () => {};
		}
	}, 'review-hub: snapshots');

	ctx.inject(['agents'], (scoped) => {
		agentsService = scoped?.agents;
	});

	ctx.inject(['llm'], (scoped) => {
		llmService = scoped?.llm;
	});
	// `ctx.llm` is feature-detected: a host without it simply never reviews.
	// `llm` is an optional service: inject it instead of reading `ctx.llm`
	// (an undeclared service read throws, which would silently disable the AI layer).
	llmAccessor = () => {
		try {
			return ctx.llm;
		} catch {
			return undefined;
		}
	};
	// One sweep per process: snapshots are the one place a plugin keeps file contents,
	// so they must not accumulate silently.
	void snapshot.sweepRetention(store.settingsSnapshot().snapshotRetentionDays).catch(() => 0);
	activeReviewer = createReviewer({
		getLlm,
		getSettings: () => store.settingsSnapshot(),
		// Verdicts outlive the process: this host restarts often, and every restart
		// would otherwise re-buy the same first batch of reviews.
		cachePath: join(store.root, 'ai-cache.json'),
		// Names-only shape of each llm chunk, so "does the host hand us usage / prompt-cache
		// counters?" is answered by evidence instead of a guess. Gated by the same forensics
		// switch as the HTTP probe, and values are never recorded.
		noteShape: (kind, keys) => {
			if (store.settingsSnapshot().debugReview !== true) return;
			void appendFile(join(store.root, 'review-probe.log'), JSON.stringify({ at: Date.now(), kind, keys }) + '\n').catch(() => undefined);
		},
	});

	ctx.effect(() => {
		answererRegistered = true;
		return ctx.on('approval/request', answerer, { prepend: true });
	}, 'review-hub: answerer');

	ctx.effect(() => () => {
		answererRegistered = false;
		pending.clear();
		if (activeStore === store) activeStore = undefined;
		if (activeSnapshot === snapshot) activeSnapshot = undefined;
		activeReviewer = undefined;
		agentsService = undefined;
		llmService = undefined;
		llmAccessor = undefined;
		llmProviderIds = [];
		llmProviderIdsAt = 0;
	}, 'review-hub: teardown');

	const resolveAgent = (sessionId) => {
		try {
			const agents = agentsService;
			if (agents === null || agents === void 0) return undefined;
			if (typeof agents.get === 'function') return agents.get(sessionId);
			if (typeof agents.find === 'function') return agents.find(sessionId);
		} catch {
			/* an unresolvable agent is a UI state, not a failure */
		}
		return undefined;
	};

	const catalog = createCatalog({
		getLlm,
		observed: observedReviewRoutes,
		// The requesting session's own lane; a session we cannot resolve has none.
		currentOf: (sessionId) => latestRoute(resolveAgent(sessionId)?.session),
	});

	ctx.inject(['webServer'], (scoped) => {
		const offs = registerRoutes(scoped?.webServer, {
			store,
			snapshot,
			agentFor: resolveAgent,
			/** A human label for "another session": the aggregate row names it. */
			titleFor: (sessionId) => titleOfSession(resolveAgent(sessionId)),
			version: VERSION,
			settings: () => store.settingsSnapshot(),
			pendingView: () => [...pending.values()],
			// Opt-in hardening: reject requests that carry neither Origin nor Sec-Fetch-Site.
			// Off by default — the desktop shell sends neither, so this would brick the panel.
			strictOrigin: rawConfig?.strictOrigin === true,
			// Header forensics for the write fence: while on, every request's header *names*
			// (plus cookie names) go to <root>/http-probe.log. Nothing secret is recorded.
			// Live predicate, not a mount-time flag: the switch lives in the panel, so it has
			// to take effect without a restart.
			probeFile: join(store.root, 'http-probe.log'),
			debugHeaders: () => debugHeaders === true || store.settingsSnapshot().debugHeaders === true,
			// The fence itself is data: name the cookie/header the panel sends and curl does
			// not. Both empty = off, which is exactly today's behaviour.
			proof: {
				cookie: typeof rawConfig?.writeProofCookie === 'string' ? rawConfig.writeProofCookie : '',
				header: typeof rawConfig?.writeProofHeader === 'string' ? rawConfig.writeProofHeader : '',
			},
			// The host's real catalog, aggregated and cached by ./catalog.js: the menu
			// offers every model the host can actually run, not only the lanes seen so far.
			modelCatalog: (session, opts) => catalog.snapshot({ session, refresh: opts?.refresh === true }),
			answererState: () => ({
				registered: answererRegistered,
				counters: { ...counters },
				reviewer: activeReviewer === undefined ? undefined : activeReviewer.stats(),
			}),
		});
		routeCount = offs.length;
		for (const off of offs) ctx.effect(() => off, 'review-hub: route');
	});
}

/** Test surface. */
export const __internals = {
	answerer,
	pending,
	counters,
	storeOf: () => activeStore,
	snapshotOf: () => activeSnapshot,
	routeCount: () => routeCount,
};
