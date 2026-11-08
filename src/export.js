/**
 * Ledger export: the same rows the panel shows, as CSV or JSON.
 * CSV carries a UTF-8 BOM and CRLF so Excel opens Chinese labels correctly.
 */

export const EXPORT_FIELDS = Object.freeze([
	'ts',
	'sessionId',
	'toolName',
	'outcome',
	'decidedBy',
	'riskLevel',
	'riskRule',
	'decisionMs',
	'argsSummary',
	'reason',
]);

function isoOf(ts) {
	const value = Number(ts);
	if (Number.isFinite(value) === false || value <= 0) return '';
	return new Date(value).toISOString();
}

function cell(value) {
	if (value === undefined || value === null) return '';
	const text = String(value);
	return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function rowOf(row) {
	return {
		ts: isoOf(row?.ts),
		sessionId: row?.sessionId ?? '',
		toolName: row?.toolName ?? '',
		outcome: row?.outcome ?? '',
		decidedBy: row?.decidedBy ?? '',
		riskLevel: row?.riskLevel ?? '',
		riskRule: row?.riskRule ?? '',
		decisionMs: row?.decisionMs ?? '',
		argsSummary: row?.argsSummary ?? '',
		reason: row?.reason ?? '',
	};
}

/** RFC4180 + BOM + CRLF. */
export function toCsv(rows) {
	const lines = [EXPORT_FIELDS.join(',')];
	for (const row of rows ?? []) {
		const flat = rowOf(row);
		lines.push(EXPORT_FIELDS.map((field) => cell(flat[field])).join(','));
	}
	return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export function toJson(rows) {
	return JSON.stringify({ version: 1, fields: EXPORT_FIELDS, rows: (rows ?? []).map(rowOf) }, null, 2);
}

/** A filename-safe slug: letters, digits and CJK survive, everything else becomes '-'. */
export function slugOf(text, max) {
	const cleaned = String(text ?? '').trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
	return cleaned.slice(0, Number(max) > 0 ? Number(max) : 40);
}

/**
 * The download name, prefixed with the session title so a folder of exports is
 * readable: `review-hub-<会话标题>-session-<stamp>.csv`.
 */
export function fileName(scope, format, title) {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const slug = slugOf(title, 40);
	const prefix = slug === '' ? 'review-hub' : 'review-hub-' + slug;
	return prefix + '-' + scope + '-' + stamp + '.' + (format === 'json' ? 'json' : 'csv');
}
