/**
 * PTC-aware evidence for one approval request.
 *
 * The approval request itself carries no arguments, so they have to be
 * reconstructed from the session log. Order matters: a PTC sub-dispatch is the
 * only event holding a nested call's real arguments, and auto-review's blind
 * denials came from looking at `tool/call` alone.
 *
 * Pure and synchronous: this runs on the approval hot path.
 */

const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|cookie|credential)/i;
const INLINE_SECRETS = [/sk-[A-Za-z0-9]{8,}/g, /Bearer\s+\S+/gi];
const REDACTED = '[redacted]';
const MAX_DEPTH = 4;
export const SUMMARY_MAX_CHARS = 240;
/** A command keeps its head and its tail: the tail is where redirections and targets live. */
export const COMMAND_HEAD_CHARS = 200;
export const COMMAND_TAIL_CHARS = 100;
// Lower-case on purpose: the host spells one of these `powerShell`, and a case-sensitive
// lookup quietly skipped the head+tail shaping for it (audit 2026-11-18).
const SHELL_TOOLS = new Set(['bash', 'win_bash', 'ops_bash', 'pwsh', 'powershell']);
const PATH_TOOLS = new Set(['edit', 'write', 'str_replace_editor', 'read']);

export function redactText(value) {
	let out = String(value ?? '');
	for (const pattern of INLINE_SECRETS) out = out.replace(pattern, REDACTED);
	return out;
}

const redactString = redactText;

function redactValue(value, depth) {
	if (typeof value === 'string') return redactString(value);
	if (value === null || typeof value !== 'object') return value;
	if (depth >= MAX_DEPTH) return REDACTED;
	if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
	const out = {};
	for (const [key, item] of Object.entries(value)) {
		out[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(item, depth + 1);
	}
	return out;
}

function hasValue(value) {
	return value !== undefined && value !== null && value !== '';
}

/** A nested call appends `:ptc:<n>` to the enclosing id the log records. */
export function callIdMatches(logged, wanted) {
	if (logged === undefined || logged === null || wanted === undefined || wanted === null) return false;
	const a = String(logged);
	const b = String(wanted);
	return a === b || b.startsWith(a + ':');
}

/** The session events of the requesting agent, read-only, or an empty list. */
export function eventsOf(request) {
	try {
		const session = request?.agent?.session;
		if (session === null || typeof session !== 'object') return [];
		const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events;
		return Array.isArray(events) ? events : [];
	} catch {
		return [];
	}
}

/**
 * Call ids this process has already handed to a decision.
 *
 * A request that carries no call id used to fall back to "the newest call of that tool
 * name", which can be a *different* invocation: the panel then showed one command and
 * the reviewer judged another (audit 2026-11-18). Without an id the newest unconsumed
 * same-name call is the best available guess; a consumed one never is.
 */
const consumed = new Set();
const CONSUMED_MAX = 200;

function consumeCall(key) {
	if (key === '') return;
	consumed.add(key);
	if (consumed.size <= CONSUMED_MAX) return;
	const first = consumed.values().next();
	if (first.done !== true) consumed.delete(first.value);
}

function scopeOf(request) {
	try {
		const session = request?.agent?.session;
		const id = session !== null && typeof session === 'object' ? session.id : undefined;
		return typeof id === 'string' ? id : '';
	} catch {
		return '';
	}
}

function findCall(events, callId, toolName, scope) {
	const log = Array.isArray(events) ? events : [];
	const hasCallId = hasValue(callId);
	const named = typeof toolName === 'string' && toolName !== '';
	const keyOf = (value) => String(scope ?? '') + '\u0000' + String(value);
	for (let index = log.length - 1; index >= 0; index -= 1) {
		const event = log[index];
		if (event === null || typeof event !== 'object') continue;
		const data = event.data;
		if (data === null || typeof data !== 'object') continue;
		if (event.type === 'tool/ptc-dispatch-start') {
			if (named && data.name !== toolName) continue;
			if (hasCallId && callIdMatches(data.subCallId, callId) === false) continue;
			if (data.arguments === null || typeof data.arguments !== 'object') continue;
			try {
				const text = JSON.stringify(data.arguments);
				if (hasValue(data.subCallId)) consumeCall(keyOf(data.subCallId));
				return { name: data.name, arguments: text };
			} catch {
				continue;
			}
		}
		if (event.type !== 'tool/call') continue;
		if (hasCallId) {
			if (callIdMatches(data.callId, callId) === false) continue;
			if (named && data.name !== toolName) continue;
			if (hasValue(data.callId)) consumeCall(keyOf(data.callId));
			return data;
		}
		if (named && data.name === toolName) {
			if (hasValue(data.callId) && consumed.has(keyOf(data.callId))) continue;
			if (hasValue(data.callId)) consumeCall(keyOf(data.callId));
			return data;
		}
	}
	return undefined;
}

function firstJsonObject(text) {
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

/**
 * A long command is cut head-and-tail, and says how much it cut. Truncating from the front
 * only made the reviewer answer "command truncated, cannot confirm" — it could not see the
 * redirection target at the end, which is exactly where the risk lives.
 */
function trimCommand(text) {
	if (text.length <= COMMAND_HEAD_CHARS + COMMAND_TAIL_CHARS) return text;
	const omitted = text.length - COMMAND_HEAD_CHARS - COMMAND_TAIL_CHARS;
	// English, like every other line the reviewer reads: this string goes *into the prompt*,
	// not into the panel dictionary, so no i18n setting reaches it (2026-11-18).
	return text.slice(0, COMMAND_HEAD_CHARS) + '\n… (' + omitted + ' chars omitted) …\n' + text.slice(-COMMAND_TAIL_CHARS);
}

function summaryOf(name, args) {
	let text;
	const key = String(name ?? '').toLowerCase();
	const isCommand = SHELL_TOOLS.has(key) && hasValue(args?.command);
	if (isCommand) text = trimCommand(redactString(String(args.command)));
	else if (PATH_TOOLS.has(key) && hasValue(args?.file_path)) text = redactString(String(args.file_path));
	else {
		try {
			text = JSON.stringify(redactValue(args, 0));
		} catch {
			text = '';
		}
	}
	if (typeof text !== 'string' || text === '') return {};
	// A shaped command already states what was cut; slicing it again here cut the *tail* —
	// which is the part the shaping was for. Found in the ledger, not in a test.
	if (isCommand) {
		return text.length > COMMAND_HEAD_CHARS + COMMAND_TAIL_CHARS
			? { argsSummary: text, argsTruncated: true }
			: { argsSummary: text };
	}
	if (text.length <= SUMMARY_MAX_CHARS) return { argsSummary: text };
	return { argsSummary: text.slice(0, SUMMARY_MAX_CHARS), argsTruncated: true };
}

/**
 * Arguments of one approval, in the order that can actually find them.
 * @returns {{ argsText?: string, argsSummary?: string, argsTruncated?: boolean, source?: 'ptc'|'call'|'reason' }}
 */
export function evidenceFor(request, events) {
	try {
		const toolName = typeof request?.toolName === 'string' ? request.toolName : '';
		const callId = request?.callId;
		const call = findCall(events, callId, toolName, scopeOf(request));
		if (call !== undefined && typeof call.arguments === 'string') {
			let parsed;
			try {
				parsed = JSON.parse(call.arguments);
			} catch {
				parsed = undefined;
			}
			const summary = parsed === undefined ? {} : summaryOf(typeof call.name === 'string' ? call.name : toolName, parsed);
			return { argsText: call.arguments, source: 'call', ...summary };
		}
		const reason = typeof request?.reason === 'string' ? request.reason : '';
		if (reason !== '' && toolName !== '') {
			const at = reason.indexOf(toolName + ' ');
			if (at >= 0) {
				const parsed = firstJsonObject(reason.slice(at + toolName.length + 1));
				if (parsed !== null && typeof parsed === 'object') {
					let argsText = '';
					try {
						argsText = JSON.stringify(parsed);
					} catch {
						argsText = '';
					}
					return { argsText, source: 'reason', ...summaryOf(toolName, parsed) };
				}
			}
		}
		return {};
	} catch {
		return {};
	}
}
/**
 * The host states a sandbox escalation as one sentence:
 * `escalate sandbox to <mode>: <tool> <args>. <a sentence true of every call of that tool>`.
 * Read as a whole it says "this is dangerous" even for a list command, which is how a
 * read-only `list_plugins` got asked about. So the mode is lifted out and the appended
 * sentence dropped: the reviewer judges the operation, the permission only floors the risk.
 */
const ESCALATE = /^\s*escalate sandbox to ([a-z][a-z0-9-]*)\s*:\s*/i;
/** Appended by the host to *every* escalated call; it describes the tool, not this call. */
const BOILERPLATE = [
	/persists? across sessions/i,
	/runs? outside the (workspace|sandbox)/i,
];
export const MODE_MAX_CHARS = 40;
export const OPERATION_MAX_CHARS = 200;

/** Index of the brace closing the one opened at `open`, or -1. String-aware. */
function matchedBrace(text, open) {
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
			if (depth === 0) return index;
		}
	}
	return -1;
}

function operationOf(rest) {
	const open = rest.indexOf('{');
	if (open >= 0) {
		const close = matchedBrace(rest, open);
		if (close > open) return rest.slice(0, close + 1).trim();
	}
	// No arguments in the sentence: keep it, minus the sentences the host appends to all of them.
	const sentences = rest.split(/(?<=[.!?])\s+/);
	return sentences.filter((sentence) => BOILERPLATE.some((pattern) => pattern.test(sentence)) === false).join(' ').trim();
}

/**
 * Split an approval reason into the requested sandbox mode and the operation it is about.
 * A reason that is not an escalation comes back with an empty mode and is otherwise untouched.
 * @returns {{ mode: string, operation: string }}
 */
export function parseEscalation(reason) {
	const text = typeof reason === 'string' ? reason : '';
	const match = ESCALATE.exec(text);
	if (match === null) return { mode: '', operation: text.trim().slice(0, OPERATION_MAX_CHARS) };
	return {
		mode: match[1].toLowerCase().slice(0, MODE_MAX_CHARS),
		operation: operationOf(text.slice(match[0].length)).slice(0, OPERATION_MAX_CHARS),
	};
}

export const BRIEF_MAX_CHARS = 160;
export const KEY_LIST_MAX_CHARS = 120;

/**
 * First sentence of a tool description: what the tool does, before the caveats. A tool whose
 * description we never saw comes back empty, and the reviewer is told nothing extra rather
 * than told something invented.
 */
export function toolBriefOf(description) {
	const text = typeof description === 'string' ? description.replace(/\s+/g, ' ').trim() : '';
	if (text === '') return '';
	const cut = text.search(/[.。!?！？](\s|$)/);
	const first = cut < 0 ? text : text.slice(0, cut + 1).trim();
	return first.slice(0, BRIEF_MAX_CHARS);
}

/** Top-level parameter names of a tool schema, so "which knobs exist" is not a guess. */
export function argumentKeysOf(parameters) {
	try {
		const props = parameters?.properties;
		if (props === null || typeof props !== 'object' || Array.isArray(props)) return '';
		return Object.keys(props).filter((key) => key !== '').join(', ').slice(0, KEY_LIST_MAX_CHARS);
	} catch {
		return '';
	}
}
