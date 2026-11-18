/**
 * Conversation context for one review — 1.3.x.
 *
 * The reviewer judges a single operation, and until now it knew nothing about what the session
 * was doing. This module hands it the last few turns, under three rules that are the whole point
 * of the file:
 *
 *  1. Messages only. Tool results, file contents, diffs and reasoning blocks never leave the
 *     process: that is where the secrets are, and none of it was ever written for a reviewer.
 *  2. Three-layer redaction, applied on the way out only. The ledger keeps the original, so the
 *     panel and the diff stay readable.
 *  3. A budget in tokens (roughly chars / 2 — conservative for Chinese, over-counts English),
 *     oldest turn dropped first.
 */

/** Chars per token. CJK is ~1.5, English ~4; 2 over-counts English and under-counts nothing. */
const CHARS_PER_TOKEN = 2;
/** One user message may be long; keep enough to carry the intent, not the whole paste. */
export const MAX_USER_CHARS = 480;
/** One assistant reply is background, so only its opening survives. */
export const MAX_ASSISTANT_CHARS = 240;
export const DEFAULT_TURNS = 3;
export const DEFAULT_TOKENS = 1500;
export const MIN_TOKENS = 200;
export const MAX_TOKENS = 8000;
export const MAX_TURNS = 10;

/** L1: shapes that are a credential wherever they appear. */
const SECRET_PATTERNS = [
	/\bsk-[A-Za-z0-9_-]{8,}/g,
	/\bghp_[A-Za-z0-9]{20,}/g,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
	/[?&#](?:access_token|api_key|apikey|secret|password|token)=[^&\s"']+/gi,
	/\b(?:password|passwd|secret|api[-_]?key)\s*[:=]\s*["']?[^\s"',}]{4,}/gi,
];

/** L2: a message carrying one of these is replaced whole — half a secret still names it. */
const WHOLE_MESSAGE = /-----BEGIN |\bsk-[A-Za-z0-9_-]{16,}|\bghp_[A-Za-z0-9]{20,}|\bxox[baprs]-|\bAKIA[0-9A-Z]{16}\b/;

/** L3: home directories keep their shape, lose the name. */
const HOME_PATTERNS = [
	/\b[A-Za-z]:\\Users\\[^\\\s"']+/gi,
	/\/home\/[^\/\s"']+/g,
	/\/Users\/[^\/\s"']+/g,
];

export const REDACTED = '[redacted]';

/** Text blocks of one message; reasoning blocks are deliberately not read. */
function textOf(data) {
	const blocks = Array.isArray(data?.content)
		? data.content
		: (Array.isArray(data?.message?.content) ? data.message.content : []);
	const parts = [];
	for (const block of blocks) {
		if (block === null || typeof block !== 'object') continue;
		if (block.type !== 'text' || typeof block.text !== 'string') continue;
		const text = block.text.trim();
		if (text !== '') parts.push(text);
	}
	return parts.join('\n');
}

/** @returns {{ text: string, redactions: number }} */
export function redactContext(text) {
	let out = typeof text === 'string' ? text : '';
	let redactions = 0;
	if (out === '') return { text: '', redactions: 0 };
	if (WHOLE_MESSAGE.test(out) === true) return { text: '[redacted:credential · ' + out.length + ' chars]', redactions: 1 };
	for (const pattern of SECRET_PATTERNS) {
		out = out.replace(pattern, () => {
			redactions += 1;
			return REDACTED;
		});
	}
	for (const pattern of HOME_PATTERNS) {
		out = out.replace(pattern, () => {
			redactions += 1;
			return '~';
		});
	}
	return { text: out, redactions };
}

function asInt(value, bounds, fallback) {
	const numeric = Number(value);
	if (Number.isFinite(numeric) === false) return fallback;
	return Math.min(bounds[1], Math.max(bounds[0], Math.round(numeric)));
}

/**
 * The last N turns of a session, rendered for the reviewer.
 *
 * Walking backwards is what makes N turns cheap: the newest user message opens turn one, and the
 * loop stops as soon as it meets the (N+1)th. One assistant message per turn is kept — the last
 * one before the next user message, which is the answer the human actually saw.
 *
 * @param {Array} events - the requesting session's events, oldest first.
 * @returns {{ text: string, redactions: number, turns: number }}
 */
export function contextFor(events, options = {}) {
	const turns = asInt(options.turns, [0, MAX_TURNS], DEFAULT_TURNS);
	if (turns === 0) return { text: '', redactions: 0, turns: 0 };
	const budget = asInt(options.tokens, [MIN_TOKENS, MAX_TOKENS], DEFAULT_TOKENS) * CHARS_PER_TOKEN;
	const list = Array.isArray(events) ? events : [];

	const picked = [];
	let seen = 0;
	let answered = false;
	for (let index = list.length - 1; index >= 0; index -= 1) {
		const event = list[index];
		const type = event === null || typeof event !== 'object' ? '' : String(event.type || '');
		if (type === 'user/message') {
			// A spliced or relayed message is not the human typing; only the source's own kind counts.
			const kind = event.data?.source?.kind;
			if (typeof kind === 'string' && kind !== 'user') continue;
			const text = textOf(event.data);
			if (text === '') continue;
			if (seen >= turns) break;
			seen += 1;
			answered = false;
			picked.push({ role: 'user', text: text.slice(0, MAX_USER_CHARS) });
			continue;
		}
		if (type === 'assistant/message') {
			if (seen === 0 || answered === true) continue;
			const text = textOf(event.data);
			if (text === '') continue;
			answered = true;
			picked.push({ role: 'assistant', text: text.slice(0, MAX_ASSISTANT_CHARS) });
		}
	}
	picked.reverse();
	// The window starts at a user message: an assistant line whose user message fell outside
	// the N turns would answer a question the reviewer never sees.
	while (picked.length > 0 && picked[0].role === 'assistant') picked.shift();

	// Budget: drop whole turns from the oldest end, never a lone assistant line.
	let keep = picked;
	let total = keep.reduce((sum, item) => sum + item.text.length + 8, 0);
	while (keep.length > 1 && total > budget) {
		total -= keep[0].text.length + 8;
		keep = keep.slice(1);
		if (keep.length > 0 && keep[0].role === 'assistant') {
			total -= keep[0].text.length + 8;
			keep = keep.slice(1);
		}
	}

	let redactions = 0;
	const out = [];
	for (const item of keep) {
		const clean = redactContext(item.text);
		redactions += clean.redactions;
		out.push(item.role + ': ' + clean.text);
	}
	return { text: out.join('\n'), redactions, turns: keep.filter((item) => item.role === 'user').length };
}