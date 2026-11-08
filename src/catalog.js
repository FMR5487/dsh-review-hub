/**
 * The host's real model catalog: every provider `ctx.llm` exposes, and the models
 * under it. The settings menu used to offer only the lanes a session had already
 * opened, so a model nobody had run yet could not be picked at all.
 *
 * Three rules follow from sitting behind a live GUI's settings page:
 *   - one slow or broken provider must not hide the others (`providerTimeoutMs`);
 *   - the arm that loses that race must be caught, or it lands in the host as an
 *     unhandled rejection;
 *   - an unusable `llm` service is a normal state, never a throw to the caller.
 */

const PROVIDER_TIMEOUT_MS = 1500;
const TTL_MS = 60000;

/** One provider call, settled exactly once: `{ value }` or `{ code }`. */
function settle(invoke, timeoutMs) {
	return new Promise((resolve) => {
		let done = false;
		const finish = (result) => {
			if (done === true) return;
			done = true;
			clearTimeout(timer);
			resolve(result);
		};
		const wait = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : PROVIDER_TIMEOUT_MS;
		const timer = setTimeout(() => finish({ code: 'timeout' }), wait);
		let promise;
		try {
			promise = Promise.resolve(invoke());
		} catch {
			finish({ code: 'throw' });
			return;
		}
		// Both arms are handlers on purpose: whichever arm loses the race rejects into
		// this closure instead of the host's unhandled-rejection path.
		promise.then((value) => finish({ value }), () => finish({ code: 'throw' }));
	});
}

/** Only id/name travel to the page; `name` falls back to the id. */
function modelsOf(listed) {
	const models = [];
	for (const model of Array.isArray(listed) ? listed : []) {
		const id = typeof model?.id === 'string' ? model.id : '';
		if (id === '') continue;
		const name = typeof model?.name === 'string' && model.name !== '' ? model.name : id;
		models.push({ id, name });
	}
	return models;
}

/** Providers and their models; every provider is settled on its own. */
async function load(getLlm, providerTimeoutMs) {
	let llm;
	try {
		llm = getLlm();
	} catch {
		llm = undefined;
	}
	if (llm === null || llm === void 0 || typeof llm.listProviders !== 'function') {
		return { providers: [], errors: [{ provider: '', code: 'unavailable' }] };
	}
	let listed;
	try {
		listed = await llm.listProviders();
	} catch {
		return { providers: [], errors: [{ provider: '', code: 'unavailable' }] };
	}
	const entries = [];
	for (const provider of Array.isArray(listed) ? listed : []) {
		const id = typeof provider?.id === 'string' ? provider.id.trim() : '';
		if (id === '') continue;
		const name = typeof provider?.name === 'string' && provider.name !== '' ? provider.name : id;
		entries.push({ id, name });
	}
	const settled = await Promise.all(entries.map(async (entry) => {
		if (typeof llm.listModels !== 'function') return { entry, models: [], code: 'unavailable' };
		const outcome = await settle(() => llm.listModels(entry.id), providerTimeoutMs);
		if (outcome.code !== undefined) return { entry, models: [], code: outcome.code };
		return { entry, models: modelsOf(outcome.value) };
	}));
	const providers = [];
	const errors = [];
	for (const result of settled) {
		providers.push({ id: result.entry.id, name: result.entry.name, models: result.models });
		if (result.code !== undefined) errors.push({ provider: result.entry.id, code: result.code });
	}
	return { providers, errors };
}

/**
 * @param {object} options
 * @param {Function} options.getLlm - () => llm service or undefined; may throw.
 * @param {Function} options.observed - () => string[] of lanes this plugin has seen.
 * @param {Function} options.currentOf - (session) => {provider, model} or undefined.
 * @param {number} [options.ttlMs] - how long the provider list is trusted.
 * @param {number} [options.providerTimeoutMs] - per-provider listModels budget.
 */
export function createCatalog(options = {}) {
	const getLlm = typeof options.getLlm === 'function' ? options.getLlm : () => undefined;
	const observed = typeof options.observed === 'function' ? options.observed : () => [];
	const currentOf = typeof options.currentOf === 'function' ? options.currentOf : () => undefined;
	const ttlMs = Number.isFinite(options.ttlMs) ? Number(options.ttlMs) : TTL_MS;
	const providerTimeoutMs = Number.isFinite(options.providerTimeoutMs) ? Number(options.providerTimeoutMs) : PROVIDER_TIMEOUT_MS;

	let cachedProviders = [];
	let cachedErrors = [];
	let fetchedAt = 0;

	async function snapshot(args = {}) {
		const refresh = args?.refresh === true;
		const now = Date.now();
		if (refresh === true || fetchedAt === 0 || now - fetchedAt >= ttlMs) {
			const loaded = await load(getLlm, providerTimeoutMs);
			cachedProviders = loaded.providers;
			cachedErrors = loaded.errors;
			fetchedAt = Date.now();
		}
		// Lanes and the session's own route are facts about right now: never cached.
		let lanes = [];
		try {
			const raw = observed();
			lanes = (Array.isArray(raw) ? raw : []).filter((lane) => typeof lane === 'string' && lane !== '');
		} catch {
			lanes = [];
		}
		let current;
		try {
			const raw = currentOf(args?.session);
			if (typeof raw?.provider === 'string' && raw.provider !== '' && typeof raw?.model === 'string' && raw.model !== '') {
				current = { provider: raw.provider, model: raw.model };
			}
		} catch {
			current = undefined;
		}
		return {
			providers: cachedProviders.map((provider) => ({
				id: provider.id,
				name: provider.name,
				models: provider.models.map((model) => ({ id: model.id, name: model.name })),
			})),
			observed: lanes.slice(),
			models: lanes.slice(),
			current: current ?? null,
			errors: cachedErrors.map((error) => ({ provider: error.provider, code: error.code })),
			fetchedAt,
		};
	}

	return { snapshot };
}
