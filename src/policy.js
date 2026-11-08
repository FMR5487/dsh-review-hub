/**
 * L0 hard-risk classes and the L1 per-tool policy table.
 *
 * The hard-risk classes exist so the AI layer can never be the reason a
 * destructive action runs: a match here is always handed to a human, never
 * counted toward memory, never shown to the reviewer.
 */

/** Tools whose arguments carry a shell command line. */
const SHELL_TOOLS = new Set(['ops_bash', 'bash', 'pwsh', 'win_bash', 'powershell', 'run_code']);

/** Paths that must never be touched without a human, whatever the tool. */
const SECRET_PATHS = [
	/\.credentials(\.ya?ml)?\b/i,
	/\.npmrc\b/i,
	/\bid_(rsa|ed25519|ecdsa)\b/i,
	/[\\/]\.ssh[\\/]/i,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\bsk-[A-Za-z0-9_-]{16,}/,
	// Reading these is the same event as leaking them: an env file, a certificate, a
	// saved credential blob, or the channel pack's account list / token ledger.
	/\.env(\.[A-Za-z0-9_-]+)?\b/i,
	/\.pem\b/i,
	/\bcredentials\.json\b/i,
	/[\\/]channel-pack[\\/]/i,
];

/** Shapes that mean "run whatever the network hands back". */
const REMOTE_EXEC = [
	/\b(curl|wget)\b[^\n|]*\|\s*(ba)?sh\b/i,
	/\b(iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n|]*\|\s*iex\b/i,
	/\bbitsadmin\b[^\n]*\/transfer\b/i,
	/\bnc\b[^\n]*\s-[a-z]*e\b/i,
	/\bncat\b/i,
];

/** Machine-level changes. */
const SYSTEM_LEVEL = [
	/\bHKLM\b|HKEY_LOCAL_MACHINE/i,
	/\bsc(\.exe)?\s+(config|stop|delete|create)\b/i,
	/\bSet-ExecutionPolicy\b/i,
	/\bbcdedit\b/i,
	/\breg(\.exe)?\s+add\b/i,
	/\bschtasks\b/i,
	/\bnet\s+user\s+\S+\s+\S+\s+\/add\b/i,
	/\b(shutdown|Restart-Computer|Stop-Computer)\b/i,
];

/** Deletion, in every dialect this host can see. */
const DELETE = [
	/\brm\s+(-[a-z-]*\s+)*-[a-z-]*[rf]/i,
	/\brmdir\b/i,
	/\bdel\s+\/[sq]/i,
	/\bRemove-Item\b[^\n]*-Recurse/i,
	/\bgit\s+clean\b[^\n]*\s-[a-z]*[xdf]/i,
	/\bunlink\b/i,
	/\bshred\b/i,
];

/**
 * Discarding work that exists only in the working tree: git has no undo for these,
 * so they are handed to a human even when the AI layer would explain them away.
 */
const DISCARD = [
	/\bgit\s+reset\b[^\n]*--hard/i,
	/\bgit\s+checkout\b[^\n]*(\s--\s|\s-f\b|\s--force\b|\s\.\s*$|\s\*)/i,
	/\bgit\s+restore\b/i,
	/\bgit\s+switch\b[^\n]*\s(-f|--force)\b/i,
	/\bgit\s+stash\b[^\n]*\b(drop|clear)\b/i,
	/\bgit\s+branch\b[^\n]*\s-[a-z]*D/i,
];

/** Anything that wipes a lot at once. */
const BATCH_DESTRUCTION = [
	/\brm\s+-[a-z-]*r[a-z-]*f?[a-z-]*\s+[^\n]*(\*|\/\s*$|~\/\s*$)/i,
	/\bgit\s+push\b[^\n]*--force/i,
	/\bmkfs(\.\w+)?\b/i,
	/\bdd\s+if=/i,
	/>\s*\/dev\/sd[a-z]/i,
	/\bformat\s+[a-z]:/i,
	/\bRemove-Item\b[^\n]*\*[^\n]*-Recurse/i,
];

/**
 * `shape` decides who gets judged by a class:
 *
 *   command — only tools that hand a string to a shell. A `write` whose *content*
 *             mentions "rm -rf" writes a file; it does not delete anything, and
 *             treating it as L0 meant every such edit was bounced to a human forever
 *             and could never be learned.
 *   path    — every tool: these patterns match a path or a literal secret, which is
 *             exactly as meaningful in `edit {file_path: ".env"}` as in a shell line.
 */
const CLASSES = [
	{ rule: 'delete', label: '删除类', patterns: DELETE, shape: 'command' },
	{ rule: 'discard', label: '丢弃改动', patterns: DISCARD, shape: 'command' },
	{ rule: 'credentials', label: '凭据类', patterns: SECRET_PATHS, shape: 'path' },
	{ rule: 'remote-exec', label: '远程执行', patterns: REMOTE_EXEC, shape: 'command' },
	{ rule: 'system', label: '系统级', patterns: SYSTEM_LEVEL, shape: 'command' },
	{ rule: 'batch', label: '批量破坏', patterns: BATCH_DESTRUCTION, shape: 'command' },
];

/** Stable, secret-free JSON so the same action always fingerprints the same. */
export function normalizeArgs(args) {
	if (args === null || typeof args !== 'object') return typeof args === 'string' ? args : '';
	const seen = new WeakSet();
	const walk = (value, depth) => {
		if (value === null || typeof value !== 'object') return value;
		if (depth > 6 || seen.has(value)) return '[deep]';
		seen.add(value);
		if (Array.isArray(value)) return value.slice(0, 50).map((item) => walk(item, depth + 1));
		const out = {};
		for (const key of Object.keys(value).sort()) {
			if (/token|secret|password|passwd|api[_-]?key|authorization|cookie|credential/i.test(key)) {
				out[key] = '[redacted]';
				continue;
			}
			out[key] = walk(value[key], depth + 1);
		}
		return out;
	};
	try {
		return JSON.stringify(walk(args, 0));
	} catch {
		return '';
	}
}

/** The command line an approval is about, whatever tool family asked. */
export function commandText(toolName, argsText) {
	if (typeof argsText !== 'string' || argsText === '') return '';
	if (SHELL_TOOLS.has(toolName) === false) return argsText;
	try {
		const parsed = JSON.parse(argsText);
		for (const key of ['command', 'cmd', 'script', 'code']) {
			if (typeof parsed?.[key] === 'string') return parsed[key];
		}
	} catch {
		// Not JSON: the raw text is all we have.
	}
	return argsText;
}

/**
 * Match one approval against the hard-risk classes.
 * @returns {{rule:string,label:string}|undefined}
 */
export function hardRisk(toolName, argsText) {
	const text = typeof argsText === 'string' ? argsText : '';
	if (text === '') return undefined;
	// Path-shaped rules look at the whole argument text; command-shaped rules look
	// at the command line so a JSON key named "delete" cannot trip them.
	const command = commandText(toolName, text);
	const runsCommands = SHELL_TOOLS.has(String(toolName ?? '').toLowerCase());
	for (const entry of CLASSES) {
		if (entry.shape === 'command' && runsCommands === false) continue;
		for (const pattern of entry.patterns) {
			if (pattern.test(text) || (command !== text && pattern.test(command))) {
				return { rule: entry.rule, label: entry.label };
			}
		}
	}
	return undefined;
}

/** Does this text name a credential file? Path-shaped only — used by snapshot redaction. */
export function isSecretLike(text) {
	const value = typeof text === 'string' ? text : '';
	if (value === '') return false;
	for (const pattern of SECRET_PATHS) {
		if (pattern.test(value)) return true;
	}
	return false;
}

export const DEFAULT_TOOLS_POLICY = Object.freeze({
	default: 'human',
	overrides: Object.freeze({
		ops_bash: 'ai',
		bash: 'ai',
		win_bash: 'ai',
		pwsh: 'ai',
		powerShell: 'ai',
		write: 'memory',
		edit: 'memory',
		str_replace_editor: 'memory',
		run_code: 'memory',
		plugin_manager: 'human',
	}),
});

/**
 * The built-in AI baseline: shell runners plus everything that only reads. Reading is
 * where a rubber stamp costs least and where a human is least able to judge — but the
 * hard-risk classes still win, so a read of a credential file never reaches this path.
 *
 * This list is code, not a setting: the settings page only carries the deltas (extra
 * tools to send to the reviewer, tools to keep away from it).
 */
export const DEFAULT_AI_TOOLS = Object.freeze([
	'ops_bash', 'bash', 'win_bash', 'pwsh', 'powerShell',
	'ops_read_files', 'ops_inspect_local_file', 'ops_grep', 'ops_glob', 'read', 'grep', 'glob',
	'web_fetch', 'read_page', 'web_search', 'x_search',
	'job_output', 'job_list', 'ops_status',
]);

/**
 * The tool table for one settings snapshot. Three layers, in order:
 *
 *   1. DEFAULT_TOOLS_POLICY   — the per-tool floors (memory tier, plugin_manager, …).
 *   2. DEFAULT_AI_TOOLS       — the built-in AI baseline, hardcoded on purpose.
 *   3. `settings.aiTools`      — extra tools to send to the reviewer.
 *   4. `settings.aiToolsDeny`  — tools to keep away from it; this wins over 2 and 3.
 *
 * A memory-tier tool stays memory at every layer: memory is the *stronger* rule, and a
 * blacklist that demoted it would silently turn "learned" into "always ask".
 */
export function toolsPolicyOf(settings) {
	const overrides = { ...DEFAULT_TOOLS_POLICY.overrides };
	const raise = (list) => {
		for (const tool of Array.isArray(list) ? list : []) {
			if (typeof tool !== 'string' || tool === '') continue;
			if (overrides[tool] === 'memory') continue;
			overrides[tool] = 'ai';
		}
	};
	const lower = (list) => {
		for (const tool of Array.isArray(list) ? list : []) {
			if (typeof tool !== 'string' || tool === '') continue;
			if (overrides[tool] === 'memory') continue;
			overrides[tool] = 'human';
		}
	};
	raise(DEFAULT_AI_TOOLS);
	raise(settings?.aiTools);
	lower(settings?.aiToolsDeny);
	return { default: DEFAULT_TOOLS_POLICY.default, overrides };
}

const TIERS = new Set(['ai', 'memory', 'human']);
const RANK = { ai: 3, memory: 2, human: 1 };

/** The tier a tool is allowed up to, ignoring who asked. */
export function tierOf(toolName, policy) {
	const table = policy ?? DEFAULT_TOOLS_POLICY;
	if (toolName !== '' && typeof table?.overrides?.[toolName] === 'string') {
		const tier = table.overrides[toolName];
		return TIERS.has(tier) ? tier : 'human';
	}
	const fallback = table?.default;
	return TIERS.has(fallback) ? fallback : 'human';
}

/** Stricter of two tiers; used by the per-agent narrowing. */
export function stricterTier(left, right) {
	const a = TIERS.has(left) ? left : 'human';
	const b = TIERS.has(right) ? right : 'human';
	return RANK[a] <= RANK[b] ? a : b;
}

/**
 * One call that answers "may this be auto-decided, and by what".
 * @returns {{tier:'ai'|'memory'|'human', hardRisk?:{rule:string,label:string}, riskLevel:string}}
 */
export function classify(toolName, argsText, options = {}) {
	const hit = hardRisk(toolName, argsText);
	if (hit !== undefined) {
		// Hard risk wins outright: no AI, no memory, no counting.
		return { tier: 'human', hardRisk: hit, riskLevel: 'high' };
	}
	// The per-agent ceiling is applied by the caller (agentPolicy.clampByAgent) so
	// this stays a pure function of the tool and its arguments.
	return { tier: tierOf(toolName, options.toolsPolicy), riskLevel: 'unknown' };
}
