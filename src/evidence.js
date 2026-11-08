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
