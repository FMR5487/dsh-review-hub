/**
 * Write-ahead snapshots: the content of a file as it was *before* a write tool ran.
 *
 * The plugin's iron rule shapes every line here. Capture happens on the tool
 * pre-execute waterfall, so it must not block, must not throw, and must never be
 * able to change the decision: the file read is the only work done inline (it has
 * to happen before the tool writes), and the disk write is queued behind the
 * caller.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { callIdMatches } from './evidence.js';
import { defaultRoot } from './store.js';
import { isSecretLike } from './policy.js';

export const SNAPSHOT_VERSION = 1;
/** Per-session ring: the oldest captured call goes first. */
export const SNAPSHOT_MAX_ENTRIES = 64;
/** One before-image cap; a bigger file keeps only its metadata. */
export const SNAPSHOT_MAX_BYTES = 256 * 1024;
/** How many sessions keep snapshots on disk; the least recently used one goes first. */
export const SNAPSHOT_MAX_SESSIONS = 64;
/** Default retention: 0 = keep until the session cap evicts it. */
export const SNAPSHOT_RETENTION_DAYS = 0;
const SNAPSHOT_TOOLS = new Set(['write', 'edit', 'str_replace_editor']);
const INDEX_FILE = 'index.json';

function safeSegment(value) {
	return String(value).replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 96) || 'unknown';
}

function nonEmptyString(value) {
	return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The tool name on a pre-execute payload, however this host spells it. */
function toolNameOf(exec) {
	return nonEmptyString(exec?.name) ?? nonEmptyString(exec?.toolName) ?? nonEmptyString(exec?.tool?.name);
}

function argsOf(exec) {
	const args = exec?.arguments ?? exec?.args ?? exec?.input;
	return args !== null && typeof args === 'object' ? args : undefined;
}

/**
 * The owning session id.
 *
 * The real `tools/pre-execute` exec carries `{ callId, rootCallId, name, agent, arguments }`
 * — there is no `sessionId` field at all, so `exec.agent.id` is the id the approval side also
 * uses (`request.agent.id`). The remaining forms are belt-and-braces for other hosts.
 */
function sessionOf(exec) {
	return nonEmptyString(exec?.agent?.id)
		?? nonEmptyString(exec?.agent?.session?.id)
		?? nonEmptyString(exec?.sessionId)
		?? nonEmptyString(exec?.session?.id)
		?? nonEmptyString(exec?.ctx?.session?.id);
}

function callIdOf(exec) {
	return nonEmptyString(exec?.callId) ?? nonEmptyString(exec?.id) ?? nonEmptyString(exec?.call?.id);
}

/** Replace the first occurrence only: `edit` rewrites one match, not every match. */
function replaceOnce(text, search, replacement) {
	const at = text.indexOf(search);
	if (at < 0) return undefined;
	return text.slice(0, at) + replacement + text.slice(at + search.length);
}

/**
 * The best guess at the post-write content, used only when the file is gone from
 * disk by the time the panel asks. Derived from the tool arguments; anything the
 * arguments cannot express yields undefined.
 */
function afterHintOf(toolName, args, before) {
	const asText = (value) => (typeof value === 'string' ? value : undefined);
	if (toolName === 'write') return asText(args.content);
	if (toolName === 'edit') {
		const search = asText(args.old_string);
		const replacement = asText(args.new_string);
		if (search === undefined || replacement === undefined || typeof before !== 'string') return undefined;
		return replaceOnce(before, search, replacement);
	}
	if (toolName === 'str_replace_editor') {
		const command = asText(args.command);
		if (command === 'create') return asText(args.file_text);
		const search = asText(args.old_str);
		const replacement = asText(args.new_str);
		if (search === undefined || replacement === undefined || typeof before !== 'string') return undefined;
		return replaceOnce(before, search, replacement);
	}
	return undefined;
}

function readBeforeSync(path) {
	try {
		const stat = statSync(path);
		if (stat.isFile() !== true) return { exists: false };
		if (stat.size > SNAPSHOT_MAX_BYTES) return { exists: true, bytes: stat.size, tooLarge: true };
		const text = readFileSync(path, 'utf8');
		return { exists: true, bytes: stat.size, text };
	} catch {
		// A missing file is the normal case for `write`; any other failure means we
		// simply have no before-image to show.
		return { exists: false };
	}
}

/**
 * Create the snapshot library.
 * @param {{ root?: string, now?: () => number }} [options] - `root` is the
 * review-hub storage root; snapshots live in its `snapshots` subdirectory.
 */
export function createSnapshot(options = {}) {
	const root = typeof options.root === 'string' && options.root.length > 0 ? options.root : defaultRoot();
	const dir = join(root, 'snapshots');
	const now = typeof options.now === 'function' ? options.now : () => Date.now();
	/** sessionId -> (callId -> entry); insertion order is capture recency. */
	const sessions = new Map();
	const loading = new Map();
	let chain = Promise.resolve();

	const indexPath = (sessionId) => join(dir, safeSegment(sessionId), INDEX_FILE);
	const bucketOf = (sessionId) => sessions.get(sessionId);

	const serialize = (task) => {
		const run = chain.then(task).then((value) => value, () => undefined);
		chain = run;
		return run;
	};

	function warn(message) {
		try {
			console.warn('review-hub: ' + message);
		} catch {
			// Logging must not become the failure.
		}
	}

	async function loadSession(sessionId) {
		let entries;
		try {
			entries = JSON.parse(await readFile(indexPath(sessionId), 'utf8'));
		} catch (error) {
			if (error?.code !== 'ENOENT') warn('snapshot load failed: ' + (error instanceof Error ? error.message : String(error)));
			return;
		}
		if (entries === null || typeof entries !== 'object' || entries.entries === null || typeof entries.entries !== 'object') return;
		let bucket = sessions.get(sessionId);
		if (bucket === undefined) {
			bucket = new Map();
			sessions.set(sessionId, bucket);
		}
		for (const [callId, entry] of Object.entries(entries.entries)) {
			if (entry === null || typeof entry !== 'object') continue;
			// A capture made since this load started is fresher than the file.
			if (bucket.has(callId)) continue;
			bucket.set(callId, entry);
		}
	}

	function ensureLoaded(sessionId) {
		if (typeof sessionId !== 'string' || sessionId === '') return Promise.resolve();
		let pending = loading.get(sessionId);
		if (pending === undefined) {
			pending = loadSession(sessionId).catch((error) => warn('snapshot load failed: ' + (error instanceof Error ? error.message : String(error))));
			loading.set(sessionId, pending);
		}
		return pending;
	}

	function persist(sessionId) {
		return serialize(async () => {
			try {
				const doc = { version: SNAPSHOT_VERSION, entries: {} };
				for (const [callId, entry] of sessions.get(sessionId) ?? []) doc.entries[callId] = entry;
				const file = indexPath(sessionId);
				await mkdir(join(dir, safeSegment(sessionId)), { recursive: true });
				const tmp = file + '.tmp';
				await writeFile(tmp, JSON.stringify(doc), 'utf8');
				await rename(tmp, file);
			} catch (error) {
				warn('snapshot persist failed: ' + (error instanceof Error ? error.message : String(error)));
			}
		});
	}

	function findKey(bucket, callId) {
		if (bucket === undefined) return undefined;
		if (bucket.has(callId)) return callId;
		const wanted = String(callId);
		for (const key of bucket.keys()) {
			// The approval request may carry the enclosing id while the tool call
			// carries the PTC-suffixed one, so match in both directions.
			if (callIdMatches(key, wanted) || callIdMatches(wanted, key)) return key;
		}
		return undefined;
	}

	/**
	 * Record the current file content for one pre-execute payload.
	 * Synchronous on purpose: the answer must be the content *before* the tool's own
	 * write, and a promise the host might not await would race it.
	 * @returns {object|undefined} the stored entry, or undefined when this call is not snapshotted.
	 */
	function capture(exec) {
		try {
			const toolName = toolNameOf(exec);
			if (SNAPSHOT_TOOLS.has(toolName) !== true) return undefined;
			const args = argsOf(exec);
			const path = nonEmptyString(args?.file_path);
			if (path === undefined) return undefined;
			const sessionId = sessionOf(exec);
			if (sessionId === undefined) return undefined;
			const callId = callIdOf(exec);
			if (callId === undefined) return undefined;
			const file = readBeforeSync(path);
			const entry = { path, before: null, bytes: file.bytes ?? 0, ts: now(), toolName };
			if (isSecretLike(path) === true) {
				// A credential file is backed up by *not* backing it up: keeping a copy of
				// .env just so an edit could be undone creates the very leak this plugin
				// exists to prevent. Metadata stays, contents do not.
				entry.redacted = true;
			} else if (file.tooLarge === true) entry.tooLarge = true;
			else if (file.exists === true) entry.before = typeof file.text === 'string' ? file.text : null;
			if (entry.tooLarge !== true && entry.redacted !== true) {
				const hint = afterHintOf(toolName, args, entry.before);
				if (typeof hint === 'string' && Buffer.byteLength(hint, 'utf8') <= SNAPSHOT_MAX_BYTES) entry.afterHint = hint;
			}
			let bucket = sessions.get(sessionId);
			if (bucket === undefined) {
				bucket = new Map();
			}
			// Re-inserting moves the session to the end: eviction drops the coldest one.
			sessions.delete(sessionId);
			sessions.set(sessionId, bucket);
			evictSessions();
			// Re-inserting refreshes its position, so eviction drops the oldest capture.
			bucket.delete(callId);
			bucket.set(callId, entry);
			while (bucket.size > SNAPSHOT_MAX_ENTRIES) {
				const oldest = bucket.keys().next();
				if (oldest.done === true) break;
				bucket.delete(oldest.value);
			}
			// The in-memory entry is already authoritative for lookups; the write only
			// has to happen eventually, and must not be awaited by the waterfall.
			void ensureLoaded(sessionId).then(() => persist(sessionId));
			return entry;
		} catch (error) {
			warn('snapshot capture failed: ' + (error instanceof Error ? error.message : String(error)));
			return undefined;
		}
	}

	/**
	 * Keep the disk side as bounded as the memory side: an unbounded pile of session
	 * directories is exactly the "history nobody asked to keep" problem.
	 */
	function evictSessions() {
		while (sessions.size > SNAPSHOT_MAX_SESSIONS) {
			const oldest = sessions.keys().next();
			if (oldest.done === true) break;
			const sessionId = oldest.value;
			sessions.delete(sessionId);
			loading.delete(sessionId);
			// Best effort: a failed unlink only costs disk, never the answer.
			void rm(join(dir, safeSegment(sessionId)), { recursive: true, force: true }).catch(() => undefined);
		}
	}

	/** Drop session directories older than the retention window (0 = keep forever). */
	let swept = false;
	async function sweepRetention(days) {
		if (swept === true) return 0;
		swept = true;
		const window = Number(days);
		if (Number.isFinite(window) !== true || window <= 0) return 0;
		const cutoff = now() - window * 24 * 60 * 60 * 1000;
		let removed = 0;
		let names = [];
		try {
			names = await readdir(dir);
		} catch {
			return 0;
		}
		for (const name of names) {
			const target = join(dir, name);
			try {
				const info = await stat(join(target, INDEX_FILE));
				if (info.mtimeMs >= cutoff) continue;
				await rm(target, { recursive: true, force: true });
				removed += 1;
			} catch {
				/* not a session directory, or already gone */
			}
		}
		return removed;
	}

	/** Whether a snapshot exists for this call. Memory only: the entries route calls it per row. */
	function has(sessionId, callId) {
		try {
			if (typeof sessionId !== 'string' || sessionId === '' || typeof callId !== 'string' || callId === '') return false;
			const bucket = bucketOf(sessionId);
			const key = findKey(bucket, callId);
			if (key === undefined) return false;
			// A redacted capture has metadata only: there is nothing to diff or revert.
			return bucket.get(key)?.redacted !== true;
		} catch {
			return false;
		}
	}

	/** The stored entry for this call (base id or PTC-suffixed id), or undefined. */
	async function lookup(sessionId, callId) {
		try {
			if (typeof sessionId !== 'string' || sessionId === '' || typeof callId !== 'string' || callId === '') return undefined;
			await ensureLoaded(sessionId);
			const bucket = bucketOf(sessionId);
			const key = findKey(bucket, callId);
			return key === undefined ? undefined : bucket.get(key);
		} catch {
			return undefined;
		}
	}

	/** Every stored entry of one session, oldest first. */
	async function load(sessionId) {
		await ensureLoaded(sessionId);
		const bucket = bucketOf(sessionId);
		if (bucket === undefined) return [];
		return Array.from(bucket, ([callId, entry]) => ({ callId, ...entry }));
	}

	/** Load the sessions a batch of rows names, so `has` can answer synchronously afterwards. */
	async function warm(sessionIds) {
		const unique = new Set();
		for (const sessionId of Array.isArray(sessionIds) ? sessionIds : []) {
			if (typeof sessionId === 'string' && sessionId !== '') unique.add(sessionId);
		}
		await Promise.all(Array.from(unique, (sessionId) => ensureLoaded(sessionId)));
	}

	return {
		root,
		dir,
		indexPath,
		capture,
		has,
		lookup,
		load,
		warm,
		ensureLoaded,
		sweepRetention,
		/** Absolute path of the session index a revert instruction tells the agent to read. */
		snapshotPath: (sessionId) => indexPath(String(sessionId ?? '')),
	};
}
