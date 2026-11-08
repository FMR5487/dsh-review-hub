/**
 * Unified diff over two in-memory strings.
 *
 * Pure and synchronous: the route layer may call it on every panel refresh, and a
 * diff must never be able to fail the approval timeline. Anything unrepresentable
 * (binary, oversized) is reported as a flag instead of an exception.
 */

/** Standard unified-diff context width. */
export const CONTEXT_LINES = 3;
/** Two change runs closer than this merge into one hunk: keeping them apart would
 * print two context blocks of the same lines. */
export const MERGE_GAP = 6;
/** Above this the panel could not render the answer anyway. */
export const MAX_DIFF_BYTES = 256 * 1024;
/** Line pairs above this skip LCS and fall back to "replace the middle": a quadratic
 * table on a 20k-line file would spend more memory than the diff is worth. */
const LCS_CELL_LIMIT = 4_000_000;

function utf8Length(text) {
	return typeof Buffer === 'function' ? Buffer.byteLength(text, 'utf8') : new TextEncoder().encode(text).length;
}

function toLines(text) {
	if (text === '') return [];
	const lines = text.split('\n');
	// A trailing newline is a terminator, not an extra empty line.
	if (lines[lines.length - 1] === '') lines.pop();
	return lines;
}

/** A NUL byte means this is not text; rendering it as lines would be a lie. */
function isBinary(text) {
	return text.indexOf('\u0000') >= 0;
}

function diffOps(a, b) {
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
	let tailA = a.length;
	let tailB = b.length;
	while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) {
		tailA -= 1;
		tailB -= 1;
	}
	const ops = [];
	for (let index = 0; index < head; index += 1) ops.push({ kind: 'ctx', text: a[index] });
	const midA = a.slice(head, tailA);
	const midB = b.slice(head, tailB);
	if (midA.length > 0 && midB.length > 0 && midA.length * midB.length <= LCS_CELL_LIMIT) {
		const width = midB.length + 1;
		const table = new Uint32Array((midA.length + 1) * width);
		for (let i = midA.length - 1; i >= 0; i -= 1) {
			for (let j = midB.length - 1; j >= 0; j -= 1) {
				table[i * width + j] = midA[i] === midB[j]
					? table[(i + 1) * width + j + 1] + 1
					: Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
			}
		}
		let i = 0;
		let j = 0;
		while (i < midA.length && j < midB.length) {
			if (midA[i] === midB[j]) {
				ops.push({ kind: 'ctx', text: midA[i] });
				i += 1;
				j += 1;
			} else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
				ops.push({ kind: 'del', text: midA[i] });
				i += 1;
			} else {
				ops.push({ kind: 'add', text: midB[j] });
				j += 1;
			}
		}
		while (i < midA.length) {
			ops.push({ kind: 'del', text: midA[i] });
			i += 1;
		}
		while (j < midB.length) {
			ops.push({ kind: 'add', text: midB[j] });
			j += 1;
		}
	} else {
		for (const text of midA) ops.push({ kind: 'del', text });
		for (const text of midB) ops.push({ kind: 'add', text });
	}
	for (let index = tailA; index < a.length; index += 1) ops.push({ kind: 'ctx', text: a[index] });
	return ops;
}

/** Attach 1-based line numbers per side; an add has no old line and a del no new one. */
function numberOps(ops) {
	let oldNo = 1;
	let newNo = 1;
	for (const op of ops) {
		if (op.kind === 'del') {
			op.noOld = oldNo;
			op.noNew = null;
			oldNo += 1;
		} else if (op.kind === 'add') {
			op.noOld = null;
			op.noNew = newNo;
			newNo += 1;
		} else {
			op.noOld = oldNo;
			op.noNew = newNo;
			oldNo += 1;
			newNo += 1;
		}
	}
}

function makeHunk(ops, start, end) {
	const lines = ops.slice(start, end + 1);
	let oldStart = 0;
	let newStart = 0;
	for (const line of lines) {
		if (line.noOld !== null && oldStart === 0) oldStart = line.noOld;
		if (line.noNew !== null && newStart === 0) newStart = line.noNew;
	}
	return {
		oldStart,
		newStart,
		lines: lines.map((line) => ({ kind: line.kind, noOld: line.noOld, noNew: line.noNew, text: line.text })),
	};
}

function buildHunks(ops) {
	const changes = [];
	for (let index = 0; index < ops.length; index += 1) {
		if (ops[index].kind !== 'ctx') changes.push(index);
	}
	if (changes.length === 0) return [];
	// Merge first, then pad: padding before merging would turn one hunk into two
	// hunks that each print the shared context lines.
	const runs = [];
	let runStart = changes[0];
	let previous = changes[0];
	for (let index = 1; index < changes.length; index += 1) {
		const current = changes[index];
		if (current - previous - 1 <= MERGE_GAP) {
			previous = current;
			continue;
		}
		runs.push([runStart, previous]);
		runStart = current;
		previous = current;
	}
	runs.push([runStart, previous]);
	return runs.map(([from, to]) => makeHunk(ops, Math.max(0, from - CONTEXT_LINES), Math.min(ops.length - 1, to + CONTEXT_LINES)));
}

/**
 * Diff `before` against `after`.
 * @param {string|null} before - null means the file did not exist yet.
 * @param {string} after - the current content.
 * @returns {{ stats: { add: number, del: number, unchanged: number }, hunks: object[] } | { binary: true } | { tooLarge: true }}
 */
export function computeDiff(before, after) {
	try {
		const textAfter = typeof after === 'string' ? after : '';
		const textBefore = typeof before === 'string' ? before : null;
		if (isBinary(textAfter) || (textBefore !== null && isBinary(textBefore))) return { binary: true };
		if (utf8Length(textAfter) > MAX_DIFF_BYTES || (textBefore !== null && utf8Length(textBefore) > MAX_DIFF_BYTES)) return { tooLarge: true };
		const ops = diffOps(textBefore === null ? [] : toLines(textBefore), toLines(textAfter));
		numberOps(ops);
		let add = 0;
		let del = 0;
		let unchanged = 0;
		for (const op of ops) {
			if (op.kind === 'add') add += 1;
			else if (op.kind === 'del') del += 1;
			else unchanged += 1;
		}
		return { stats: { add, del, unchanged }, hunks: buildHunks(ops) };
	} catch {
		// An unexpected failure is reported in the only vocabulary the caller renders.
		return { tooLarge: true };
	}
}
