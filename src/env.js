/**
 * Where the session is standing — 1.3.1.
 *
 * `rm -rf build` means one thing at a repository root and another at C:\. The reviewer has
 * never been told which one it is looking at, so this module answers two questions from what
 * the session already logged:
 *
 *   1. the working directory (the host writes it into every runtime-context snapshot), and
 *   2. whether a path in the arguments lands inside that directory, outside it, or in a
 *      system location.
 *
 * Both are deterministic and cheap. Neither goes near the file system: the snapshot is already
 * in the event log, and scope is string comparison against a normalised root.
 */

/** The host's own wording, seen 236 times in one session's log. */
const CWD_LINE = /Current working directory:\s*"?([^"\n]+)"?/;

/** Directories nobody should be writing to by accident. */
const SYSTEM_PATHS = [
	/^[a-z]:\/(windows|program files( \(x86\))?|programdata)(\/|$)/,
	/^\/(etc|usr|bin|sbin|var|boot|dev|proc|sys)(\/|$)/,
	/^\/(system|library)(\/|$)/,
];

/** One form for comparison: forward slashes, no trailing slash, lower case. */
function normalise(value) {
	const text = typeof value === 'string' ? value.trim().replace(/\\/g, '/') : '';
	if (text === '') return '';
	const trimmed = text.length > 1 && text.endsWith('/') ? text.slice(0, -1) : text;
	return trimmed.toLowerCase();
}

/**
 * The newest working directory the session logged, or '' when the host never said.
 * @param {Array} events - the session's events, oldest first.
 */
export function workingDirectoryOf(events) {
	const list = Array.isArray(events) ? events : [];
	for (let index = list.length - 1; index >= 0; index -= 1) {
		const event = list[index];
		if (event === null || typeof event !== 'object' || event.type !== 'system/message') continue;
		const blocks = Array.isArray(event.data?.content) ? event.data.content : [];
		for (const block of blocks) {
			if (block === null || typeof block !== 'object' || typeof block.text !== 'string') continue;
			const hit = CWD_LINE.exec(block.text);
			if (hit === null) continue;
			const value = hit[1].trim();
			if (value !== '') return value;
		}
	}
	return '';
}

/** Absolute paths a text mentions, in the order they appear, deduplicated. */
export function pathsIn(text) {
	const source = typeof text === 'string' ? text : '';
	const found = [];
	const pattern = /(?:[a-z]:[\\/][^"',\s]+|\/(?:home|Users|etc|usr|var|tmp|opt|root|private)[^"',\s]*)/gi;
	let hit = pattern.exec(source);
	while (hit !== null) {
		const value = hit[0].replace(/[.,;:)\]}]+$/, '');
		if (value !== '' && found.indexOf(value) < 0) found.push(value);
		if (found.length >= 4) break;
		hit = pattern.exec(source);
	}
	return found;
}

/**
 * Where one path lands relative to the workspace root.
 * @returns {'inside'|'outside'|'system'|''}
 */
export function pathScopeOf(path, root) {
	const target = normalise(path);
	if (target === '') return '';
	for (const pattern of SYSTEM_PATHS) if (pattern.test(target) === true) return 'system';
	const base = normalise(root);
	if (base === '') return 'outside';
	if (target === base) return 'inside';
	return target.startsWith(base + '/') === true ? 'inside' : 'outside';
}

/**
 * The reviewer's environment block, or '' when the session never said where it stands.
 * Lines are short on purpose: this is a caption, not a dossier.
 */
export function environmentOf(events, options = {}) {
	const cwd = workingDirectoryOf(events);
	if (cwd === '') return '';
	const root = typeof options.root === 'string' && options.root !== '' ? options.root : cwd;
	const lines = ['working directory: ' + cwd];
	if (normalise(root) !== normalise(cwd)) lines.push('workspace root: ' + root);
	if (options.isGit === true) lines.push('inside a git repository: yes');
	else if (options.isGit === false) lines.push('inside a git repository: no');
	const scopes = pathsIn(options.argsText);
	if (scopes.length > 0) {
		const labelled = scopes.map((path) => path + ' (' + (pathScopeOf(path, root) || 'unknown') + ')');
		lines.push('paths in this call: ' + labelled.join(', '));
	}
	return lines.join('\n');
}