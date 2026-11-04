// ============================================================================
// Daemon socket — the one local address a Worker knows without configuration.
//
// The socket carries Worker registration only, never the browser surface, so a
// local Worker needs no port guess and the web listener stays free to move. One
// listener serves two kinds of peer:
//
//   probe   — a launcher's one-shot question before it commits to a role. The
//             reply carries the worker protocol version and the Daemon's web
//             address, so a stale file, an unrelated UNIX service, and a
//             mismatched bridge are distinct, actionable results, and a joining
//             Worker can name the page a browser should open.
//   worker  — a registration: the first frame is `hello`, which is handed to
//             the Daemon together with the socket. The peek consumes that frame,
//             so the adoption is seeded with it rather than requiring a second
//             handshake.
//
// Nothing here decides a role or owns a Worker; it is the transport-shaped half
// of discovery (`discovery.ts` holds the decision).
// ============================================================================

import { lstatSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { createConnection } from "node:net";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { ProbeResult } from "./discovery.ts";
import type { WorkerHello } from "./worker-client.ts";
import {
	isWorkerProbeRequest,
	WORKER_PROBE_ID,
	WORKER_PROTOCOL_VERSION,
	workerProbeReply,
	workerProbeRequest,
} from "./worker-protocol.ts";

/** A listener that does not answer is not a daemon, and one that answers slowly
 * is not one worth waiting for. */
const PROBE_TIMEOUT_MS = 1_500;

/** How long an accepted socket may stay silent before it is dropped: a peer that
 * upgrades and never greets is neither a probe nor a Worker. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** The Windows named-pipe namespace, where `node:net` binds and nowhere else.
 * Pipes live in one machine-global namespace, so the user name in the default
 * carries the per-user isolation the UNIX default gets from `$HOME`. */
const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";

/** True when `socketPath` is already a pipe name in either Windows form. */
function isWindowsPipeName(socketPath: string): boolean {
	return socketPath.startsWith(WINDOWS_PIPE_PREFIX) || socketPath.startsWith("\\\\?\\pipe\\");
}

/** Encode an arbitrary account name into an ASCII token that `new URL("ws+unix:…")`
 * leaves untouched (`ws` parses `ws+unix:` through `URL` without percent-decoding
 * the socket path, and splits on `:`). `[0-9A-Za-z.-]` stay verbatim; every other
 * UTF-8 byte — including `_` itself — becomes `_xx`, so distinct names cannot
 * collide. */
function encodePipeSegment(raw: string): string {
	let out = "";
	for (const byte of Buffer.from(raw, "utf8")) {
		const plain =
			(byte >= 0x30 && byte <= 0x39) ||
			(byte >= 0x41 && byte <= 0x5a) ||
			(byte >= 0x61 && byte <= 0x7a) ||
			byte === 0x2d ||
			byte === 0x2e;
		out += plain ? String.fromCharCode(byte) : `_${byte.toString(16).padStart(2, "0")}`;
	}
	return out;
}

/** The account segment of the Windows pipe name. `userInfo` can fail on a
 * stripped environment, where a shared default still beats no default. */
function windowsUserSegment(username?: string): string {
	let raw = username;
	if (raw === undefined) {
		try {
			raw = userInfo().username;
		} catch {
			return "default";
		}
	}
	return raw === "" ? "default" : encodePipeSegment(raw);
}

/**
 * The default local discovery address: one per user, independent of pi's agent
 * directory.
 *
 * Windows has no UNIX socket for `net.Server.listen()`: a plain filesystem path
 * is rejected with `EACCES`, so the default names a pipe instead of a file under
 * `$HOME`.
 */
export function defaultDaemonSocketPath(username?: string): string {
	if (process.platform === "win32") return `${WINDOWS_PIPE_PREFIX}pi-bridge-${windowsUserSegment(username)}`;
	return join(homedir(), ".pi", "bridge.sock");
}

/** The `ws+unix:` URL a Worker uses to reach a daemon socket. */
export function daemonSocketUrl(socketPath: string): string {
	return `ws+unix:${socketPath}:/`;
}

/** Normalize an endpoint (`unix:/path` or a `ws://` URL) into a WebSocket URL. */
export function endpointUrl(endpoint: string): string {
	return endpoint.startsWith("unix:") ? daemonSocketUrl(endpoint.slice("unix:".length)) : endpoint;
}

/** The browser base URL of a remote daemon: one HTTP server carries both the
 * page and the WebSocket upgrade, so only the scheme changes. Null for a local
 * socket, whose port only the daemon knows. */
export function webBaseUrlFromEndpoint(endpoint: string): string | null {
	if (endpoint.startsWith("unix:")) return null;
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return null;
	}
	if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
	return `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`;
}

/** True when the path itself is a UNIX socket. `lstat` deliberately does not
 * follow a symlink: only a socket entry may be treated as an abandoned
 * endpoint, and removal must never follow a link to some other file. */
function isSocketEntry(socketPath: string): boolean {
	try {
		return lstatSync(socketPath).isSocket();
	} catch {
		return false;
	}
}

/** True when something accepts connections on `socketPath`. A refused connect
 * with the file present is a stale socket, not a missing one. An entry that is
 * not a socket at all is reported instead: a refused connect says nothing about
 * what the path names. */
function canConnect(socketPath: string): Promise<"ok" | "absent" | "stale" | { error: string }> {
	return new Promise((resolve) => {
		const socket = createConnection(socketPath);
		const done = (result: "ok" | "absent" | "stale" | { error: string }) => {
			socket.destroy();
			resolve(result);
		};
		socket.once("connect", () => done("ok"));
		socket.once("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "ENOENT") return done("absent");
			if (err.code === "ECONNREFUSED" || err.code === "ENOTSOCK") {
				// A refused connect proves nothing about the entry: Linux reports
				// ECONNREFUSED for a regular file too, so classifying that as stale
				// would let startup unlink an unrelated file.
				return isSocketEntry(socketPath)
					? done("stale")
					: done({ error: `${socketPath} exists but is not a UNIX socket` });
			}
			return done({ error: `Cannot reach ${socketPath}: ${err.code ?? err.message}` });
		});
	});
}

/**
 * Remove a path the probe reported as a stale socket. The entry is re-checked
 * here because the probe's answer describes the moment it ran: a file that
 * replaced the socket meanwhile must not be unlinked.
 */
export function removeStaleSocket(socketPath: string): void {
	try {
		if (!lstatSync(socketPath).isSocket()) {
			throw new Error(`${socketPath} is not a UNIX socket; refusing to remove it`);
		}
	} catch (err) {
		// The entry is already gone: nothing to recover.
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		throw err;
	}
	rmSync(socketPath, { force: true });
}

/** Open a WebSocket to an endpoint, with a bounded connect deadline. */
export function openWorkerSocket(endpoint: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(endpointUrl(endpoint));
		const timer = setTimeout(() => {
			ws.terminate();
			reject(new Error(`Timed out connecting to ${endpoint}`));
		}, PROBE_TIMEOUT_MS * 4);
		ws.once("open", () => {
			clearTimeout(timer);
			resolve(ws);
		});
		ws.once("error", (err: Error) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

/** Ask one open socket for its protocol version. A one-shot listener keeps this
 * independent of the peer a link installs later. */
function ping(ws: WebSocket): Promise<Record<string, unknown> | null> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (reply: Record<string, unknown> | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			ws.off("message", onMessage);
			resolve(reply);
		};
		const onMessage = (data: unknown): void => {
			try {
				const frame = JSON.parse(String(data)) as Record<string, unknown>;
				if (frame !== null && typeof frame === "object" && frame.id === WORKER_PROBE_ID) finish(frame);
			} catch {
				// Not a protocol frame: keep waiting for the answer.
			}
		};
		const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
		ws.on("message", onMessage);
		ws.send(workerProbeRequest());
	});
}

/**
 * Probe the socket: connect, ask for the protocol version, and check it. Only a
 * compatible answer counts as live, so a stale file, an unrelated unix service,
 * and a mismatched bridge all produce distinct, actionable results.
 */
export async function probeDaemonSocket(socketPath: string): Promise<ProbeResult> {
	const reachable = await canConnect(socketPath);
	if (reachable === "absent" || reachable === "stale") return { kind: reachable };
	if (reachable !== "ok") return { kind: "refused", reason: reachable.error };

	let ws: WebSocket;
	try {
		ws = await openWorkerSocket(`unix:${socketPath}`);
	} catch (err) {
		return {
			kind: "refused",
			reason: `${socketPath} accepted a connection but not a WebSocket: ${(err as Error).message}`,
		};
	}

	const reply = await ping(ws);
	ws.close();
	if (reply === null) {
		return { kind: "refused", reason: `${socketPath} is live but did not answer as a pi-bridge daemon.` };
	}
	if (reply.ok !== true) {
		return { kind: "refused", reason: `${socketPath} refused the handshake: ${String(reply.error)}` };
	}
	if (reply.protocol !== WORKER_PROTOCOL_VERSION) {
		return {
			kind: "refused",
			reason: `${socketPath} speaks pi-bridge worker protocol ${String(reply.protocol)}, this build speaks ${WORKER_PROTOCOL_VERSION}. Stop the old daemon or use a different --socket.`,
		};
	}
	return { kind: "live", web: typeof reply.web === "string" ? reply.web : null };
}

export interface DaemonSocketOptions {
	/** Bind here: a UNIX socket path, or a Windows named-pipe name. */
	readonly socketPath: string;
	/** One accepted Worker registration. The handshake frame was consumed by the
	 * socket's peek and is supplied here, so the host can adopt the socket
	 * without waiting for a second `hello`. */
	readonly onWorker: (ws: WebSocket, hello: WorkerHello) => void;
	/** The browser base URL a probe reply advertises. Read per probe, because the
	 * listener may bind after this socket does. */
	readonly webAddress?: () => string | null;
}

export interface DaemonSocket {
	readonly socketPath: string;
	/** Terminate every registration socket, close the listener, and unlink the
	 * path. A Worker that dialed in keeps its runtimes: it reconnects or exits on
	 * its own terms. */
	close(): Promise<void>;
}

function parseJson(data: unknown): Record<string, unknown> | null {
	try {
		const value = JSON.parse(String(data)) as unknown;
		return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** A structurally valid `hello` push, or null. The adoption path validates the
 * protocol and the registration; this only decides whether the first frame is a
 * registration at all. */
function asHello(frame: Record<string, unknown>): WorkerHello | null {
	if (frame.kind !== "hello") return null;
	if (typeof frame.protocol !== "number") return null;
	if (typeof frame.registration !== "object" || frame.registration === null) return null;
	if (typeof frame.info !== "object" || frame.info === null) return null;
	return frame as unknown as WorkerHello;
}

/** A bind failure worded for what the caller can actually change. Windows
 * rejects a non-pipe name with EACCES and no cause, so the expected shape is
 * named; the raw code reads as a permissions problem in the home directory. */
function listenFailure(socketPath: string, err: Error): Error {
	if (process.platform === "win32" && !isWindowsPipeName(socketPath)) {
		return new Error(
			`cannot listen on ${socketPath}: on Windows the daemon socket must be a named pipe (${WINDOWS_PIPE_PREFIX}<name>)`,
		);
	}
	return err;
}

/**
 * Bind the registration socket. A Worker dials this path; the Daemon never dials
 * out for a local registration, which is what makes discovery possible.
 *
 * The parent directory is created first: the default path lives under
 * `$HOME/.pi`, and a standalone daemon hosts no Worker, so nothing else would
 * create it — a missing parent otherwise fails with EACCES and names no cause.
 * A Windows pipe name has no parent directory, so nothing is created for it.
 */
export async function startDaemonSocket(options: DaemonSocketOptions): Promise<DaemonSocket> {
	if (!isWindowsPipeName(options.socketPath)) {
		mkdirSync(dirname(options.socketPath), { recursive: true, mode: 0o700 });
	}

	const wss = new WebSocketServer({ noServer: true });
	const server: HttpServer = createServer();
	server.on("upgrade", (request, socket, head) => {
		// The socket carries registration only, so no path distinguishes peers:
		// the first frame does (probe or `hello`).
		wss.handleUpgrade(request, socket, head, (ws) => accept(ws));
	});

	const accept = (ws: WebSocket): void => {
		let handedOff = false;
		const timer = setTimeout(() => {
			if (handedOff) return;
			ws.close(1008, "expected a probe or a worker handshake");
		}, HANDSHAKE_TIMEOUT_MS);
		const onFirstFrame = (data: unknown): void => {
			const frame = parseJson(data);
			if (frame === null) return;

			if (isWorkerProbeRequest(frame)) {
				// Reply, then close once flushed: the probe needs the answer, and a
				// socket left open for a peer that never sends again is a leak.
				ws.send(workerProbeReply(options.webAddress?.() ?? null), () => ws.close());
				return;
			}

			const hello = asHello(frame);
			if (hello === null) return;
			// The hello is consumed by this peek, so stop listening before handing
			// over: the adoption is seeded with the frame it already read.
			handedOff = true;
			clearTimeout(timer);
			ws.off("message", onFirstFrame);
			options.onWorker(ws, hello);
		};
		ws.on("message", onFirstFrame);
	};

	await new Promise<void>((resolve, reject) => {
		const onError = (err: Error) => reject(listenFailure(options.socketPath, err));
		server.once("error", onError);
		server.listen(options.socketPath, () => {
			server.off("error", onError);
			resolve();
		});
	});

	let closed: Promise<void> | null = null;
	return {
		socketPath: options.socketPath,
		close: () => {
			if (closed !== null) return closed;
			closed = (async () => {
				for (const ws of wss.clients) ws.terminate();
				wss.close();
				await new Promise<void>((resolve) => server.close(() => resolve()));
				// A UNIX socket path outlives the listener; leaving the file behind
				// makes the next start see a stale endpoint instead of an absent one.
				if (isSocketEntry(options.socketPath)) rmSync(options.socketPath, { force: true });
			})();
			return closed;
		},
	};
}
