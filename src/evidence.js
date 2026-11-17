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
const SHELL_TOOLS = new Set(['bash', 'win_bash', 'ops_bash', 'pwsh', 'powershell']);
const PATH_TOOLS = new Set(['edit', 'write', 'str_replace_editor', 'read']);

function redactString(value) {
	let out = value;
	for (const pattern of INLINE_SECRETS) out = out.replace(pattern, REDACTED);
	return out;
}

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

function findCall(events, callId, toolName) {
	const log = Array.isArray(events) ? events : [];
	const hasCallId = hasValue(callId);
	const named = typeof toolName === 'string' && toolName !== '';
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
				return { name: data.name, arguments: JSON.stringify(data.arguments) };
			} catch {
				continue;
			}
		}
		if (event.type !== 'tool/call') continue;
		if (hasCallId) {
			if (callIdMatches(data.callId, callId) === false) continue;
			if (named && data.name !== toolName) continue;
			return data;
		}
		if (named && data.name === toolName) return data;
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

function summaryOf(name, args) {
	let text;
	if (SHELL_TOOLS.has(name) && hasValue(args?.command)) text = redactString(String(args.command));
	else if (PATH_TOOLS.has(name) && hasValue(args?.file_path)) text = redactString(String(args.file_path));
	else {
		try {
			text = JSON.stringify(redactValue(args, 0));
		} catch {
			text = '';
		}
	}
	if (typeof text !== 'string' || text === '') return {};
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
		const call = findCall(events, callId, toolName);
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
