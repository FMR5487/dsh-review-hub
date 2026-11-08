import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TMP_ROOT = fileURLToPath(new URL('./.tmp/', import.meta.url));

export async function freshRoot(name) {
	const dir = join(TMP_ROOT, name);
	await rm(dir, { recursive: true, force: true });
	await mkdir(dir, { recursive: true });
	return dir;
}

export function assertEqual(actual, expected, message) {
	if (actual !== expected) {
		throw new Error((message === undefined ? '' : message + ': ') + 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
	}
}

export function assertTrue(value, message) {
	if (value !== true) throw new Error((message === undefined ? '' : message + ': ') + 'expected true, got ' + JSON.stringify(value));
}

/** A request/response pair good enough for the route handlers. */
export async function callRoute(handler, options = {}) {
	const method = options.method ?? 'GET';
	const url = options.url ?? '/';
	const headers = Object.assign({ host: '127.0.0.1:1234', origin: 'http://127.0.0.1:1234' }, options.headers ?? {});
	const payload = options.body === undefined ? undefined : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
	const req = {
		method,
		url,
		headers,
		async *[Symbol.asyncIterator]() {
			if (payload !== undefined) yield Buffer.from(payload, 'utf8');
		},
	};
	const chunks = [];
	const res = {
		statusCode: 200,
		headers: {},
		writableEnded: false,
		setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
		end(chunk) {
			if (chunk !== undefined) chunks.push(Buffer.from(chunk));
			this.writableEnded = true;
		},
	};
	await handler(req, res);
	const text = Buffer.concat(chunks).toString('utf8');
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = undefined;
	}
	return { status: res.statusCode, headers: res.headers, text, json };
}

/** A cordis-shaped context: effect runs and hands back a disposer. */
export function fakeCtx() {
	const listeners = [];
	const ctx = {
		logger: { warn: () => {} },
		effect(fn) {
			const off = fn();
			return () => { if (typeof off === 'function') off(); };
		},
		on(event, listener) {
			listeners.push({ event, listener });
			return () => {
				const at = listeners.findIndex((entry) => entry.listener === listener);
				if (at >= 0) listeners.splice(at, 1);
			};
		},
		inject(_deps, callback) {
			// The host resolves services here; tests expose the ones a plugin asks for.
			callback({ webServer: undefined, llm: ctx.llm, agents: ctx.agents });
		},
	};
	return { ctx, listeners };
}
