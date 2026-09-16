// Daemon activation integration tests (ADR 11) — drives the Project/activation
// registry through the injectable managerFactory seam over a real WS client.
// The faux Managers are stubs (not running pi): this covers daemon routing,
// activation sharing, detach-before-attach, idle GC, session queries, and the
// address/identity rules, not pi itself.

import { existsSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Document, Patch, RpcReply, SessionRef } from "../../src/core/index.ts";
import { type ConnectionHandle, Daemon, type DaemonOptions, type Manager } from "../../src/host/index.ts";

// ---------------------------------------------------------------------------
// Stub Manager
// ---------------------------------------------------------------------------

interface StubHandles {
	emitPatch: (patch: Patch) => void;
	/** Flip the stub document's streaming flag and emit the matching patch —
	 * exercises both the daemon's onPatch listener and the GC eligibility
	 * check, which reads `document.status.isStreaming`. */
	setStreaming: (streaming: boolean) => void;
	patchListenerCount: () => number;
	disposed: () => boolean;
}

interface StubManager {
	manager: Manager;
	handles: StubHandles;
	sessionId: string;
	sessionFile: string;
}

function emptyStubDocument(): Document {
	return {
		status: {
			leafId: null,
			name: "",
			model: { provider: "", modelId: "" },
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			stats: {
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: { total: 0 },
				messages: 0,
			},
			contextUsage: null,
			pendingSteer: [],
		},
		scopedModels: [],
		entries: {},
	};
}

/** Encode a cwd the way getDefaultSessionDir does (agentDir/sessions/--cwd--). */
function sessionDirFor(cwd: string, agentDir: string): string {
	const safePath = `--${resolve(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
	return join(resolve(agentDir), "sessions", safePath);
}

let stubCounter = 0;

function makeStubManager(opts: {
	cwd?: string;
	agentDir?: string;
	sessionPath?: string;
	sessionId?: string;
	/** Pre-populated document entries — an entry-bearing unflushed session. */
	entries?: Document["entries"];
}): StubManager {
	const cwd = opts.cwd ?? "";
	const agentDir = opts.agentDir ?? "";
	const sessionId = opts.sessionId ?? `sess-${++stubCounter}`;
	const sessionFile =
		opts.sessionPath ?? join(sessionDirFor(cwd, agentDir), `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
	const document = emptyStubDocument();
	document.entries = opts.entries ?? {};
	const patchListeners = new Set<(patch: Patch) => void>();
	const settledListeners = new Set<() => void>();
	const connectionHandles = new Set<ConnectionHandle>();
	let wasDisposed = false;

	const manager: Manager = {
		get document() {
			return document;
		},
		liveSessionId: sessionId,
		cwd,
		sessionFile,
		createdAt: "2026-01-01T00:00:00Z",
		onPatch(listener) {
			patchListeners.add(listener);
			return () => patchListeners.delete(listener);
		},
		onSettled(listener) {
			settledListeners.add(listener);
			return () => settledListeners.delete(listener);
		},
		addConnection(handle, session: SessionRef) {
			connectionHandles.add(handle);
			handle.onInitialSync({ kind: "replace", session, document });
		},
		removeConnection(handle) {
			connectionHandles.delete(handle);
		},
		async prompt() {},
		async executeBash() {},
		async abort() {},
		async discardSteer() {},
		async setModel() {},
		async setThinkingLevel() {},
		async renameSession() {},
		async navigate() {},
		async dispose() {
			wasDisposed = true;
		},
	};

	const emit = (patch: Patch) => {
		for (const l of patchListeners) l(patch);
		for (const h of connectionHandles) h.onPatch(patch);
	};

	const handles: StubHandles = {
		emitPatch: emit,
		setStreaming: (streaming: boolean) => {
			document.status.isStreaming = streaming;
			emit({ ops: [{ op: "replace", path: "/status/isStreaming", value: streaming }] });
		},
		patchListenerCount: () => patchListenerCount(patchListeners, connectionHandles),
		disposed: () => wasDisposed,
	};

	return { manager, handles, sessionId, sessionFile };
}

function patchListenerCount(
	patchListeners: Set<(patch: Patch) => void>,
	connectionHandles: Set<ConnectionHandle>,
): number {
	// The daemon registers one onPatch listener per activation for the
	// streaming-state broadcast; attached Connections add a handle each.
	return patchListeners.size + connectionHandles.size;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const daemons: Daemon[] = [];
const cleanups: Array<() => void> = [];
const stubs = new Map<string, StubManager>();

afterEach(async () => {
	while (daemons.length) {
		const d = daemons.pop();
		if (d) await d.dispose();
	}
	while (cleanups.length) cleanups.pop()?.();
	stubs.clear();
});

/** Create a temp project root with two allowlisted cwds. */
function makeProjectRoots(): { root: string; agentDir: string; a: string; b: string } {
	const root = join(tmpdir(), `pi-bridge-act-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const agentDir = join(root, "agent");
	const a = join(root, "proj-a");
	const b = join(root, "proj-b");
	mkdirSync(a, { recursive: true });
	mkdirSync(b, { recursive: true });
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	return { root, agentDir, a, b };
}

/** Factory that records stubs by session id, mirroring the daemon's injected
 * manager factory seam (`CreateManagerOptions`). */
function stubMediator(): NonNullable<DaemonOptions["managerFactory"]> {
	return async (opts) => {
		const stub = makeStubManager(opts ?? {});
		stubs.set(stub.sessionId, stub);
		return stub.manager;
	};
}

async function startDaemon(opts: DaemonOptions): Promise<{ port: number; daemon: Daemon }> {
	const daemon = new Daemon();
	daemons.push(daemon);
	await daemon.start(opts);
	const addr = daemon.address;
	if (!addr) throw new Error("daemon not listening");
	return { port: addr.port, daemon };
}

function openClient(port: number): Promise<WebSocket> {
	return new Promise((resolvePromise, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		ws.on("open", () => resolvePromise(ws));
		ws.on("error", reject);
	});
}

function collectFrames(ws: WebSocket): unknown[] {
	const frames: unknown[] = [];
	ws.on("message", (data) => {
		try {
			frames.push(JSON.parse(data.toString()));
		} catch {
			// ignore malformed
		}
	});
	return frames;
}

let rpcId = 0;
function send(ws: WebSocket, frame: Record<string, unknown>): string {
	const id = String(++rpcId);
	ws.send(JSON.stringify({ id, ...frame }));
	return id;
}

function waitFor(frames: unknown[], pred: (f: Record<string, unknown>) => boolean, timeout = 5000): Promise<unknown> {
	return new Promise((resolvePromise, reject) => {
		const existing = frames.find((f) => pred(f as Record<string, unknown>));
		if (existing) return resolvePromise(existing);
		const timer = setTimeout(() => reject(new Error("timeout waiting for frame")), timeout);
		const interval = setInterval(() => {
			const match = frames.find((f) => pred(f as Record<string, unknown>));
			if (match) {
				clearTimeout(timer);
				clearInterval(interval);
				resolvePromise(match);
			}
		}, 20);
	});
}

function waitForReply(frames: unknown[], id: string): Promise<RpcReply> {
	return waitFor(frames, (f) => f.id === id) as Promise<RpcReply>;
}

function waitForPush(frames: unknown[], kind: string): Promise<Record<string, unknown>> {
	return waitFor(frames, (f) => f.kind === kind) as Promise<Record<string, unknown>>;
}

async function settle(ms = 60): Promise<void> {
	await new Promise((r) => setTimeout(r, ms));
}

/** Header + one user message, so a fixture file is a parseable session. */
function sessionFileText(sessionId: string, cwd: string): string {
	return `${[
		JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00Z", cwd }),
		JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-01-01T00:00:01Z",
			message: { role: "user", content: "hello", timestamp: 0 },
		}),
	].join("\n")}\n`;
}

/** Write a minimal durable session file at an explicit path. */
function writeSessionAt(file: string, sessionId: string, cwd: string): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, sessionFileText(sessionId, cwd));
}

/** Write a minimal durable session file; returns its stem. */
function writeSessionFile(cwd: string, agentDir: string, sessionId: string, stem?: string): string {
	const dir = sessionDirFor(cwd, agentDir);
	const name = stem ?? `2026-01-01T00-00-00-000Z_${sessionId}`;
	writeSessionAt(join(dir, `${name}.jsonl`), sessionId, cwd);
	return name;
}

/** Raw HTTP/1.1 GET over a plain socket — bypasses client-side path
 * normalization so a literal `..` request reaches the server verbatim. */
function rawHttpRequest(port: number, path: string): Promise<{ status: number; body: string }> {
	return new Promise((resolvePromise, reject) => {
		const socket = createConnection({ port, host: "127.0.0.1" }, () => {
			socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
		});
		const chunks: Buffer[] = [];
		socket.on("data", (d) => chunks.push(d));
		socket.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			const sep = raw.indexOf("\r\n\r\n");
			resolvePromise({
				status: Number(raw.split(" ", 3)[1]),
				body: sep >= 0 ? raw.slice(sep + 4) : "",
			});
		});
		socket.on("error", reject);
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("daemon: projects", () => {
	it("getDaemonInfo reports the configured projects", async () => {
		const { agentDir, a, b } = makeProjectRoots();
		const { port } = await startDaemon({ agentDir, allow: [a, b] });
		const ws = await openClient(port);
		const frames = collectFrames(ws);

		const id = send(ws, { verb: "getDaemonInfo" });
		const reply = (await waitForReply(frames, id)) as unknown as {
			ok: boolean;
			projects: Array<{ id: string; cwd: string }>;
			devMode: boolean;
		};
		expect(reply.ok).toBe(true);
		expect(reply.projects.map((p) => p.id).sort()).toEqual([basename(a).toLowerCase(), basename(b).toLowerCase()]);
		expect(reply.projects.find((p) => p.id === basename(a).toLowerCase())?.cwd).toBe(resolve(a));

		ws.close();
	});

	it("rejects duplicate ids and shared session storage at startup", async () => {
		const { agentDir, a } = makeProjectRoots();
		await expect(new Daemon().start({ agentDir, allow: [a, a] })).rejects.toThrow(/Duplicate project id/);
		await expect(new Daemon().start({ agentDir, allow: [`x=${a}`, `y=${a}`] })).rejects.toThrow(
			/share a session storage directory/,
		);
	});

	it("rejects invalid and missing allow entries at startup", async () => {
		const { agentDir, a } = makeProjectRoots();
		await expect(new Daemon().start({ agentDir, allow: [join(a, "nope")] })).rejects.toThrow(/does not exist/);
		await expect(new Daemon().start({ agentDir, allow: [`Bad_Id=${a}`] })).rejects.toThrow(/Invalid project id/);
	});
});

describe("daemon: session scan containment", () => {
	it("omits a session symlink that escapes the Project namespace", async () => {
		const { root, agentDir, a } = makeProjectRoots();
		// A real session file outside the Project's session namespace.
		writeSessionAt(join(root, "outside", "secret.jsonl"), "outside-id", a);
		const dir = sessionDirFor(a, agentDir);
		mkdirSync(dir, { recursive: true });
		symlinkSync(join(root, "outside", "secret.jsonl"), join(dir, "leak.jsonl"));

		const { port } = await startDaemon({ agentDir, allow: [a], managerFactory: stubMediator() });
		const projectId = basename(a).toLowerCase();
		const ws = await openClient(port);
		const frames = collectFrames(ws);
		const reply = (await waitForReply(frames, send(ws, { verb: "listSessions", projectId }))) as unknown as {
			sessions: Array<{ stem: string }>;
		};
		expect(reply.sessions.some((s) => s.stem === "leak")).toBe(false);

		ws.close();
	});

	it("omits an escaping symlink from the startup session-id conflict scan", async () => {
		const { root, agentDir, a } = makeProjectRoots();
		// Both files claim the same session id; the escaping one must not be
		// counted as a second address (which would refuse startup).
		writeSessionFile(a, agentDir, "same-id", "2026-01-01T00-00-00-000Z_real");
		writeSessionAt(join(root, "outside", "secret.jsonl"), "same-id", a);
		const dir = sessionDirFor(a, agentDir);
		symlinkSync(join(root, "outside", "secret.jsonl"), join(dir, "leak.jsonl"));

		const { port } = await startDaemon({ agentDir, allow: [a], managerFactory: stubMediator() });
		const projectId = basename(a).toLowerCase();
		const ws = await openClient(port);
		const frames = collectFrames(ws);
		const reply = (await waitForReply(frames, send(ws, { verb: "listSessions", projectId }))) as unknown as {
			sessions: Array<{ stem: string }>;
		};
		expect(reply.sessions.map((s) => s.stem)).toContain("2026-01-01T00-00-00-000Z_real");
		expect(reply.sessions.some((s) => s.stem === "leak")).toBe(false);

		ws.close();
	});
});

describe("daemon: session activation", () => {
	it("newSession attaches, lists as active/unflushed, and is addressable", async () => {
		const { agentDir, a } = makeProjectRoots();
		const { port } = await startDaemon({ agentDir, allow: [a], managerFactory: stubMediator() });
		const ws = await openClient(port);
		const frames = collectFrames(ws);
		const projectId = basename(a).toLowerCase();

		const id = send(ws, { verb: "newSession", projectId });
		const reply = (await waitForReply(frames, id)) as unknown as { ok: boolean; session: SessionRef };
		expect(reply.ok).toBe(true);
		expect(reply.session.projectId).toBe(projectId);
		expect(reply.session.stem).toContain(reply.session.sessionId);
		await waitForPush(frames, "replace");

		const listId = send(ws, { verb: "listActiveSessions" });
		const list = (await waitForReply(frames, listId)) as unknown as {
			sessions: Array<{ sessionId: string; stem: string; active: boolean }>;
		};
		expect(list.sessions).toHaveLength(1);
		expect(list.sessions[0].sessionId).toBe(reply.session.sessionId);
		expect(list.sessions[0].active).toBe(true);

		ws.close();
	});

	it("two newSession calls yield two independent sessions", async () => {
		const { agentDir, a } = makeProjectRoots();
		let factoryCalls = 0;
		const { port } = await startDaemon({
			agentDir,
			allow: [a],
			managerFactory: async (opts) => {
				factoryCalls++;
				return makeStubManager(opts ?? {}).manager;
			},
		});
		const ws = await openClient(port);
		const frames = collectFrames(ws);
		const projectId = basename(a).toLowerCase();

		const first = (await waitForReply(frames, send(ws, { verb: "newSession", projectId }))) as unknown as {
			session: SessionRef;
		};
		const second = (await waitForReply(frames, send(ws, { verb: "newSession", projectId }))) as unknown as {
			session: SessionRef;
		};

		expect(first.session.stem).not.toBe(second.session.stem);
		expect(first.session.sessionId).not.toBe(second.session.sessionId);
		expect(factoryCalls).toBe(2);

		ws.close();
	});

	it("openSession shares one activation across connections and reattaches after detach", async () => {
		const { agentDir, a } = makeProjectRoots();
		let factoryCalls = 0;
		const stubRef: { current: StubManager | null } = { current: null };
		const { port } = await startDaemon({
			agentDir,
			allow: [a],
			managerFactory: async (opts) => {
				factoryCalls++;
				const stub = makeStubManager(opts ?? {});
				stubRef.current = stub;
				return stub.manager;
			},
		});
		const projectId = basename(a).toLowerCase();
		const stem = writeSessionFile(a, agentDir, "durable-1");

		const ws1 = await openClient(port);
		const frames1 = collectFrames(ws1);
		const open1 = send(ws1, { verb: "openSession", projectId, stem });
		expect((await waitForReply(frames1, open1)).ok).toBe(true);
		await waitForPush(frames1, "replace");

		// A second connection to the same address converges on the same runtime.
		const ws2 = await openClient(port);
		const frames2 = collectFrames(ws2);
		const open2 = send(ws2, { verb: "openSession", projectId, stem });
		expect((await waitForReply(frames2, open2)).ok).toBe(true);
		await waitForPush(frames2, "replace");
		expect(factoryCalls).toBe(1);

		// A patch from the shared activation reaches both attached tabs.
		const stub = stubRef.current;
		if (!stub) throw new Error("stub not created");
		const before1 = frames1.length;
		const before2 = frames2.length;
		stub.handles.emitPatch({ ops: [{ op: "replace", path: "/status/isStreaming", value: true }] });
		await settle();
		expect(frames1.length).toBeGreaterThan(before1);
		expect(frames2.length).toBeGreaterThan(before2);

		// Detach ws1: its own lazy patch stream stops, ws2 keeps receiving.
		expect((await waitForReply(frames1, send(ws1, { verb: "detach" }))).ok).toBe(true);
		const afterDetach = frames1.length;
		stub.handles.emitPatch({ ops: [{ op: "replace", path: "/status/isStreaming", value: false }] });
		await settle();
		expect(frames1.length).toBe(afterDetach);

		// Re-opening the address reuses the live activation (no new Manager).
		const reopen = send(ws1, { verb: "openSession", projectId, stem });
		expect((await waitForReply(frames1, reopen)).ok).toBe(true);
		await waitForPush(frames1, "replace");
		expect(factoryCalls).toBe(1);

		ws1.close();
		ws2.close();
	});

	it("rejects unknown projects, unknown stems, and escaping stems", async () => {
		const { agentDir, a } = makeProjectRoots();
		const { port } = await startDaemon({ agentDir, allow: [a], managerFactory: stubMediator() });
		const ws = await openClient(port);
		const frames = collectFrames(ws);
		const projectId = basename(a).toLowerCase();

		expect((await waitForReply(frames, send(ws, { verb: "openSession", projectId: "nope", stem: "x" }))).ok).toBe(
			false,
		);
		expect((await waitForReply(frames, send(ws, { verb: "openSession", projectId, stem: "missing" }))).ok).toBe(
			false,
		);
		expect((await waitForReply(frames, send(ws, { verb: "openSession", projectId, stem: "../escape" }))).ok).toBe(
			false,
		);

		ws.close();
	});

	it("a failed open leaves the previous attachment intact", async () => {
		const { agentDir, a } = makeProjectRoots();
		const stubRef: { current: StubManager | null } = { current: null };
		const { port } = await startDaemon({
			agentDir,
			allow: [a],
			managerFactory: async (opts) => {
				const stub = makeStubManager(opts ?? {});
				stubRef.current = stub;
				return stub.manager;
			},
		});
		const projectId = basename(a).toLowerCase();
		const stem = writeSessionFile(a, agentDir, "keep-1");

		const ws = await openClient(port);
		const frames = collectFrames(ws);
		expect((await waitForReply(frames, send(ws, { verb: "openSession", projectId, stem }))).ok).toBe(true);
		await waitForPush(frames, "replace");

		// The client restores its previous address on a failed open, which is
		// only correct if the server kept the old attachment alive.
		expect((await waitForReply(frames, send(ws, { verb: "openSession", projectId, stem: "missing" }))).ok).toBe(
			false,
		);
		const stub = stubRef.current;
		if (!stub) throw new Error("stub not created");
		const before = frames.length;
		stub.handles.emitPatch({ ops: [{ op: "replace", path: "/status/isStreaming", value: true }] });
		await settle();
		expect(frames.length).toBeGreaterThan(before);

		ws.close();
	});

	it("rejects duplicate session ids across the session namespaces at startup", async () => {
		const { agentDir, a } = makeProjectRoots();
		// Two durable files whose headers share one session id.
		writeSessionFile(a, agentDir, "dup-id", "2026-01-01T00-00-00-000Z_first");
		writeSessionFile(a, agentDir, "dup-id", "2026-01-01T00-00-01-000Z_second");

		await expect(new Daemon().start({ agentDir, allow: [a] })).rejects.toThrow(/Duplicate session id/);
	});

	it("refuses a second open claiming an already-registered session id", async () => {
		const { agentDir, a } = makeProjectRoots();
		// Distinct file headers (so the startup scan passes); the stub reports one
		// session id for both addresses, exercising the open-time owner check.
		const first = writeSessionFile(a, agentDir, "hdr-first", "2026-01-01T00-00-00-000Z_first");
		writeSessionFile(a, agentDir, "hdr-second", "2026-01-01T00-00-01-000Z_second");

		const { port } = await startDaemon({
			agentDir,
			allow: [a],
			// Both files' headers claim `dup-id`; the stub mirrors that so the
			// daemon's single-owner check is exercised (the stub does not read
			// the file header itself).
			managerFactory: async (opts) => makeStubManager({ ...(opts ?? {}), sessionId: "dup-id" }).manager,
		});
		const ws = await openClient(port);
		const frames = collectFrames(ws);
		const projectId = basename(a).toLowerCase();

		expect((await waitForReply(frames, send(ws, { verb: "openSession", projectId, stem: first }))).ok).toBe(true);
		const conflict = await waitForReply(
			frames,
			send(ws, { verb: "openSession", projectId, stem: "2026-01-01T00-00-01-000Z_second" }),
		);
		expect(conflict.ok).toBe(false);

		ws.close();
	});
});

describe("daemon: idle GC", () => {
	it("collects a detached durable activation after the idle delay", async () => {
		const { agentDir, a } = makeProjectRoots();
		let factoryCalls = 0;
		const { port } = await startDaemon({
			agentDir,
			allow: [a],
			idleGcMs: 40,
			unflushedIdleGcMs: 40,
			managerFactory: async (opts) => {
				factoryCalls++;
				return makeStubManager(opts ?? {}).manager;
			},
		});
		const projectId = basename(a).toLowerCase();
		const stem = writeSessionFile(a, agentDir, "gc-1");

		const ws = await openClient(port);
		const frames = collectFrames(ws);
		expect((await waitForReply(frames, send(ws, { verb: "openSession", projectId, stem }))).ok).toBe(true);
		await waitForPush(frames, "replace");
		expect((await waitForReply(frames, send(ws, { verb: "detach" }))).ok).toBe(true);

		// Let the GC fire, then observe the empty active snapshot.
		await settle(150);
		const listId = send(ws, { verb: "listActiveSessions" });
		const list = (await waitForReply(frames, listId)) as unknown as { sessions: unknown[] };
		expect(list.sessions).toEqual([]);
		// GC disposes the runtime; it never deletes the session file.
		expect(existsSync(join(sessionDirFor(a, agentDir), `${stem}.jsonl`))).toBe(true);

		// Reopening rebuilds the activation from the file.
		expect((await waitForReply(frames, send(ws, { verb: "openSession", projectId, stem }))).ok).toBe(true);
		await waitForPush(frames, "replace");
		expect(factoryCalls).toBe(2);

		ws.close();
	});

	it("does not collect an attached activation", async () => {
		const { agentDir, a } = makeProjectRoots();
		let factoryCalls = 0;
		const stubRef: { current: StubManager | null } = { current: null };
		const { port } = await startDaemon({
			agentDir,
			allow: [a],
			idleGcMs: 40,
			unflushedIdleGcMs: 40,
			managerFactory: async (opts) => {
				factoryCalls++;
				const stub = makeStubManager(opts ?? {});
				stubRef.current = stub;
				return stub.manager;
			},
		});
		const projectId = basename(a).toLowerCase();
		const stem = writeSessionFile(a, agentDir, "gc-2");

		const ws = await openClient(port);
		const frames = collectFrames(ws);
		expect((await waitForReply(frames, send(ws, { verb: "openSession", projectId, stem }))).ok).toBe(true);
		await waitForPush(frames, "replace");

		await settle(150);
		expect(stubRef.current?.handles.disposed()).toBe(false);
		const listId = send(ws, { verb: "listActiveSessions" });
		const list = (await waitForReply(frames, listId)) as unknown as { sessions: unknown[] };
		expect(list.sessions).toHaveLength(1);
		expect(factoryCalls).toBe(1);

		ws.close();
	});

	it("reserves the address during disposal so a concurrent open cannot duplicate the runtime", async () => {
		const { agentDir, a } = makeProjectRoots();
		let factoryCalls = 0;
		let signalDisposeStarted!: () => void;
		const disposeStarted = new Promise<void>((r) => {
			signalDisposeStarted = r;
		});
		let releaseDispose!: () => void;
		const disposeGate = new Promise<void>((r) => {
			releaseDispose = r;
		});
		const { port } = await startDaemon({
			agentDir,
			allow: [a],
			idleGcMs: 20,
			unflushedIdleGcMs: 20,
			managerFactory: async (opts) => {
				factoryCalls++;
				const stub = makeStubManager(opts ?? {});
				const originalDispose = stub.manager.dispose.bind(stub.manager);
				stub.manager.dispose = async () => {
					signalDisposeStarted();
					await disposeGate;
					await originalDispose();
				};
				return stub.manager;
			},
		});
		const projectId = basename(a).toLowerCase();
		const stem = writeSessionFile(a, agentDir, "gc-race");

		const ws = await openClient(port);
		const frames = collectFrames(ws);
		expect((await waitForReply(frames, send(ws, { verb: "openSession", projectId, stem }))).ok).toBe(true);
		await waitForPush(frames, "replace");
		expect((await waitForReply(frames, send(ws, { verb: "detach" }))).ok).toBe(true);

		// GC fires and blocks inside disposal.
		await disposeStarted;

		// An open during disposal must wait for the reservation rather than
		// create a second Manager for the same address (ADR 11 exclusivity).
		const openId = send(ws, { verb: "openSession", projectId, stem });
		await settle(80);
		expect(frames.some((f) => (f as { id?: string }).id === openId)).toBe(false);
		expect(factoryCalls).toBe(1);

		releaseDispose();
		expect((await waitForReply(frames, openId)).ok).toBe(true);
		expect(factoryCalls).toBe(2);

		ws.close();
	});

	it("collects an entry-bearing unflushed activation only after the longer cap", async () => {
		const { agentDir, a } = makeProjectRoots();
		const { port } = await startDaemon({
			agentDir,
			allow: [a],
			idleGcMs: 40,
			unflushedIdleGcMs: 300,
			// Entry-bearing document: the stub session file is never written, so
			// the activation holds non-durable entries only the long cap protects.
			managerFactory: async (opts) =>
				makeStubManager({
					...(opts ?? {}),
					entries: {
						m1: {
							id: "m1",
							parentId: null,
							timestamp: "2026-01-01T00:00:00Z",
							kind: "message",
							role: "user",
							content: [],
						},
					},
				}).manager,
		});
		const ws = await openClient(port);
		const frames = collectFrames(ws);
		const projectId = basename(a).toLowerCase();

		expect((await waitForReply(frames, send(ws, { verb: "newSession", projectId }))).ok).toBe(true);
		expect((await waitForReply(frames, send(ws, { verb: "detach" }))).ok).toBe(true);

		// Past the short idle delay: the longer unflushed cap still holds.
		await settle(150);
		let list = (await waitForReply(frames, send(ws, { verb: "listActiveSessions" }))) as unknown as {
			sessions: unknown[];
		};
		expect(list.sessions).toHaveLength(1);

		// Past the longer cap: collected (entries were never durable).
		await settle(400);
		list = (await waitForReply(frames, send(ws, { verb: "listActiveSessions" }))) as unknown as {
			sessions: unknown[];
		};
		expect(list.sessions).toEqual([]);

		ws.close();
	});

	it("does not collect a streaming activation; collects it once it settles", async () => {
		const { agentDir, a } = makeProjectRoots();
		const stubRef: { current: StubManager | null } = { current: null };
		const { port } = await startDaemon({
			agentDir,
			allow: [a],
			idleGcMs: 40,
			unflushedIdleGcMs: 40,
			managerFactory: async (opts) => {
				const stub = makeStubManager(opts ?? {});
				stubRef.current = stub;
				return stub.manager;
			},
		});
		const projectId = basename(a).toLowerCase();
		const stem = writeSessionFile(a, agentDir, "gc-stream");

		const ws = await openClient(port);
		const frames = collectFrames(ws);
		expect((await waitForReply(frames, send(ws, { verb: "openSession", projectId, stem }))).ok).toBe(true);
		await waitForPush(frames, "replace");

		const stub = stubRef.current;
		if (!stub) throw new Error("stub not created");
		stub.handles.setStreaming(true);
		expect((await waitForReply(frames, send(ws, { verb: "detach" }))).ok).toBe(true);

		// The idle timer fires but re-arms while the session is streaming.
		await settle(150);
		const list = (await waitForReply(frames, send(ws, { verb: "listActiveSessions" }))) as unknown as {
			sessions: Array<{ stem: string; isStreaming: boolean }>;
		};
		expect(list.sessions).toHaveLength(1);
		expect(list.sessions[0].isStreaming).toBe(true);
		expect(stub.handles.disposed()).toBe(false);

		// Settling releases the re-armed timer.
		stub.handles.setStreaming(false);
		await settle(150);
		const settled = (await waitForReply(frames, send(ws, { verb: "listActiveSessions" }))) as unknown as {
			sessions: unknown[];
		};
		expect(settled.sessions).toEqual([]);
		expect(stub.handles.disposed()).toBe(true);

		ws.close();
	});

	it("does not pin an activation when the socket closes mid-open", async () => {
		const { agentDir, a } = makeProjectRoots();
		let signalFactory!: () => void;
		const factoryCalled = new Promise<void>((r) => {
			signalFactory = r;
		});
		let releaseFactory!: () => void;
		const factoryGate = new Promise<void>((r) => {
			releaseFactory = r;
		});
		const { port } = await startDaemon({
			agentDir,
			allow: [a],
			idleGcMs: 40,
			unflushedIdleGcMs: 40,
			managerFactory: async (opts) => {
				signalFactory();
				await factoryGate;
				return makeStubManager(opts ?? {}).manager;
			},
		});
		const projectId = basename(a).toLowerCase();
		const stem = writeSessionFile(a, agentDir, "gc-dead");

		const ws = await openClient(port);
		send(ws, { verb: "openSession", projectId, stem });
		await factoryCalled;

		// Close while the activation is still being created. The close handler
		// runs before the open resumes, so the attach must be skipped rather
		// than pin the activation with a dead Connection forever.
		const closed = new Promise<void>((r) => ws.on("close", r));
		ws.close();
		await closed;
		await settle(50);
		releaseFactory();
		await settle(250);

		const ws2 = await openClient(port);
		const frames2 = collectFrames(ws2);
		const list = (await waitForReply(frames2, send(ws2, { verb: "listActiveSessions" }))) as unknown as {
			sessions: unknown[];
		};
		expect(list.sessions).toEqual([]);

		ws2.close();
	});
});

describe("daemon: session listing", () => {
	it("paginates by the compound cursor and reports the unflushed active session", async () => {
		const { agentDir, a } = makeProjectRoots();
		const { port } = await startDaemon({ agentDir, allow: [a], managerFactory: stubMediator() });
		const projectId = basename(a).toLowerCase();

		// Two durable files with distinct mtimes.
		const older = writeSessionFile(a, agentDir, "older", "2026-01-01T00-00-00-000Z_older");
		await settle(20);
		const newer = writeSessionFile(a, agentDir, "newer", "2026-01-01T00-00-01-000Z_newer");

		const ws = await openClient(port);
		const frames = collectFrames(ws);

		const page1Id = send(ws, { verb: "listSessions", projectId, max: 1 });
		const page1 = (await waitForReply(frames, page1Id)) as unknown as {
			sessions: Array<{ stem: string }>;
			hasMore: boolean;
			nextCursor?: { sortTimeMs: number; stem: string };
		};
		expect(page1.sessions).toHaveLength(1);
		expect(page1.sessions[0].stem).toBe(newer);
		expect(page1.hasMore).toBe(true);
		expect(page1.nextCursor).toBeDefined();

		const page2Id = send(ws, { verb: "listSessions", projectId, max: 1, cursor: page1.nextCursor });
		const page2 = (await waitForReply(frames, page2Id)) as unknown as {
			sessions: Array<{ stem: string }>;
			hasMore: boolean;
		};
		expect(page2.sessions.map((s) => s.stem)).toEqual([older]);
		expect(page2.hasMore).toBe(false);

		// An unflushed active session is included as a normal row.
		const newId = send(ws, { verb: "newSession", projectId });
		const created = (await waitForReply(frames, newId)) as unknown as { session: SessionRef };
		const allId = send(ws, { verb: "listSessions", projectId });
		const all = (await waitForReply(frames, allId)) as unknown as {
			sessions: Array<{ stem: string; active: boolean; sessionId: string }>;
		};
		const createdRow = all.sessions.find((s) => s.stem === created.session.stem);
		expect(createdRow).toBeDefined();
		expect(createdRow?.active).toBe(true);
		expect(createdRow?.sessionId).toBe(created.session.sessionId);

		ws.close();
	});

	it("paginates equal-mtime files by the stem tiebreak without skipping or repeating", async () => {
		const { agentDir, a } = makeProjectRoots();
		const { port } = await startDaemon({ agentDir, allow: [a], managerFactory: stubMediator() });
		const projectId = basename(a).toLowerCase();
		const dir = sessionDirFor(a, agentDir);
		const stemA = writeSessionFile(a, agentDir, "eq-a-id", "eq-a");
		const stemB = writeSessionFile(a, agentDir, "eq-b-id", "eq-b");
		// Force identical ordering values so only the stem tiebreak separates
		// the two rows (ADR 11 compound cursor).
		const t = new Date(1_700_000_000_000);
		utimesSync(join(dir, `${stemA}.jsonl`), t, t);
		utimesSync(join(dir, `${stemB}.jsonl`), t, t);

		const ws = await openClient(port);
		const frames = collectFrames(ws);

		const page1 = (await waitForReply(frames, send(ws, { verb: "listSessions", projectId, max: 1 }))) as unknown as {
			sessions: Array<{ stem: string }>;
			hasMore: boolean;
			nextCursor?: { sortTimeMs: number; stem: string };
		};
		expect(page1.sessions.map((s) => s.stem)).toEqual([stemB]); // stem descending
		expect(page1.hasMore).toBe(true);
		expect(page1.nextCursor?.stem).toBe(stemB);

		const page2 = (await waitForReply(
			frames,
			send(ws, { verb: "listSessions", projectId, max: 1, cursor: page1.nextCursor }),
		)) as unknown as { sessions: Array<{ stem: string }>; hasMore: boolean };
		expect(page2.sessions.map((s) => s.stem)).toEqual([stemA]);
		expect(page2.hasMore).toBe(false);

		ws.close();
	});

	it("broadcasts sessions_changed for the Project and a global active snapshot", async () => {
		const { agentDir, a } = makeProjectRoots();
		const { port } = await startDaemon({ agentDir, allow: [a], managerFactory: stubMediator() });
		const projectId = basename(a).toLowerCase();
		const stem = writeSessionFile(a, agentDir, "chg-1");

		// An unattached launcher tab must still receive the broadcasts.
		const launcher = await openClient(port);
		const launcherFrames = collectFrames(launcher);

		const ws = await openClient(port);
		const frames = collectFrames(ws);
		expect((await waitForReply(frames, send(ws, { verb: "openSession", projectId, stem }))).ok).toBe(true);
		await waitForPush(frames, "replace");

		// Rename triggers a project-scoped first-page refresh.
		const renameId = send(ws, { verb: "renameSession", name: "renamed" });
		expect((await waitForReply(frames, renameId)).ok).toBe(true);
		const changed = await waitForPush(frames, "sessions_changed");
		expect(changed.projectId).toBe(projectId);
		expect(Array.isArray(changed.sessions)).toBe(true);

		const active = await waitForPush(launcherFrames, "active_sessions_changed");
		expect((active.sessions as Array<{ stem: string }>).some((s) => s.stem === stem)).toBe(true);

		ws.close();
		launcher.close();
	});
});

describe("daemon: http static serving", () => {
	it("rejects a literal ../ request that resolves outside webRoot", async () => {
		const { root, agentDir, a } = makeProjectRoots();
		const webRoot = join(root, "web");
		mkdirSync(webRoot, { recursive: true });
		writeFileSync(join(webRoot, "index.html"), "<html></html>");
		// A sibling directory sharing webRoot's string prefix — exactly what a
		// non-boundary `startsWith` containment check would let through once
		// join() resolves the `..` component.
		mkdirSync(join(root, "webx"), { recursive: true });
		writeFileSync(join(root, "webx", "secret.txt"), "secret");

		const { port } = await startDaemon({ agentDir, allow: [a], webRoot, managerFactory: stubMediator() });

		const rejected = await rawHttpRequest(port, "/../webx/secret.txt");
		expect(rejected.status).toBe(403);
		expect(rejected.body).not.toContain("secret");

		// Sanity: a real asset still serves.
		const ok = await rawHttpRequest(port, "/index.html");
		expect(ok.status).toBe(200);
	});
});
