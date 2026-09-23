// Daemon activation integration tests (ADR 11) — drives the Project/activation
// registry through the injectable managerFactory seam over a real WS client.
// The faux Managers are stubs (not running pi): this covers daemon routing,
// activation sharing, detach-before-attach, idle GC, session queries, and the
// address/identity rules, not pi itself.

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { AuthStorage, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Document, Patch, RpcReply, SessionRef } from "../../src/core/index.ts";
import { type ConnectionHandle, Daemon, type DaemonOptions, type Manager } from "../../src/host/index.ts";

// ---------------------------------------------------------------------------
// Stub Manager
// ---------------------------------------------------------------------------

interface StubHandles {
	emitPatch: (patch: Patch) => void;
	/** Ordered lifecycle events ("model" / "admit" / "attach") — ordering
	 * assertions. */
	events: () => string[];
	/** Texts passed to promptAdmitted. */
	admittedTexts: () => string[];
	/** `(text, images)` pairs passed to promptAdmitted. */
	admittedCalls: () => Array<{ text: string; images?: unknown[] }>;
	/** Models passed to setModel, in order. */
	setModelCalls: () => Array<{ provider: string; modelId: string }>;
	/** Thinking levels passed to setThinkingLevel, in order. */
	setThinkingLevelCalls: () => string[];
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
	/** Makes promptAdmitted reject — a refused first-prompt admission. */
	admitError?: Error;
	/** Makes setModel reject — an unknown newSession model. */
	setModelError?: Error;
}): StubManager {
	const cwd = opts.cwd ?? "";
	const agentDir = opts.agentDir ?? "";
	const sessionId = opts.sessionId ?? `sess-${++stubCounter}`;
	const sessionFile =
		opts.sessionPath ?? join(sessionDirFor(cwd, agentDir), `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
	const document = emptyStubDocument();
	document.entries = opts.entries ?? {};
	const patchListeners = new Set<(patch: Patch) => void>();
	const events: string[] = [];
	const admittedTexts: string[] = [];
	const admittedCalls: Array<{ text: string; images?: unknown[] }> = [];
	const setModelCalls: Array<{ provider: string; modelId: string }> = [];
	const setThinkingLevelCalls: string[] = [];
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
			events.push("attach");
			connectionHandles.add(handle);
			handle.onInitialSync({ kind: "replace", session, document });
		},
		removeConnection(handle) {
			connectionHandles.delete(handle);
		},
		async prompt() {},
		async promptAdmitted(text: string, images?: unknown[]) {
			events.push("admit");
			if (opts.admitError) throw opts.admitError;
			admittedTexts.push(text);
			admittedCalls.push({ text, images });
		},
		async executeBash() {},
		async abort() {},
		async discardSteer() {},
		async setModel(provider: string, modelId: string) {
			events.push("model");
			if (opts.setModelError) throw opts.setModelError;
			setModelCalls.push({ provider, modelId });
		},
		async setThinkingLevel(level: string) {
			events.push("level");
			setThinkingLevelCalls.push(level);
		},
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
		events: () => [...events],
		admittedTexts: () => [...admittedTexts],
		admittedCalls: () => [...admittedCalls],
		setModelCalls: () => [...setModelCalls],
		setThinkingLevelCalls: () => [...setThinkingLevelCalls],
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

/** A faux provider with two models and stored auth on a fresh ModelRuntime —
 * enough to exercise getDaemonInfo's catalogue and scope resolution. */
async function makeFauxRuntime(): Promise<ModelRuntime> {
	const faux = registerFauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }] });
	const authStorage = AuthStorage.inMemory();
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage });
	await modelRuntime.setRuntimeApiKey("faux", "faux-key");
	modelRuntime.registerProvider("faux", {
		baseUrl: faux.getModel("faux-1")!.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((m) => ({
			id: m.id,
			name: m.name,
			api: m.api,
			reasoning: m.reasoning,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			baseUrl: m.baseUrl,
		})),
	});
	cleanups.push(() => faux.unregister());
	return modelRuntime;
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
			projects: Array<{ id: string; cwd: string; defaultModel: unknown; defaultThinkingLevel: unknown }>;
			devMode: boolean;
		};
		expect(reply.ok).toBe(true);
		expect(reply.projects.map((p) => p.id).sort()).toEqual([basename(a).toLowerCase(), basename(b).toLowerCase()]);
		expect(reply.projects.find((p) => p.id === basename(a).toLowerCase())?.cwd).toBe(resolve(a));
		// No configured auth → no available models → no default pair.
		for (const p of reply.projects) {
			expect(p.defaultModel).toBeNull();
			expect(p.defaultThinkingLevel).toBeNull();
		}

		ws.close();
	});

	it("listFiles resolves against a Project's cwd with no session attached", async () => {
		const { agentDir, a } = makeProjectRoots();
		mkdirSync(join(a, "src"), { recursive: true });
		writeFileSync(join(a, "src", "alpha.ts"), "// a");
		writeFileSync(join(a, "src", "beta.ts"), "// b");

		const { port } = await startDaemon({ agentDir, allow: [a] });
		const ws = await openClient(port);
		const frames = collectFrames(ws);
		const projectId = basename(a).toLowerCase();

		// Deliberately no openSession: pre-send completion on the Project home
		// has no attachment (ADR 12).
		const id = send(ws, { verb: "listFiles", projectId, prefix: "src/a" });
		const reply = (await waitForReply(frames, id)) as unknown as {
			ok: boolean;
			entries: Array<{ path: string; isDirectory: boolean }>;
		};
		expect(reply.ok).toBe(true);
		expect(reply.entries.map((e) => e.path)).toEqual(["src/alpha.ts"]);

		// An unknown Project is an error, not a fallback to some other cwd.
		const bad = send(ws, { verb: "listFiles", projectId: "nope", prefix: "" });
		const badReply = await waitForReply(frames, bad);
		expect(badReply.ok).toBe(false);
		expect(String(badReply.error)).toContain("Unknown project");

		ws.close();
	});

	it("listFiles tilde prefixes with a trailing slash list the directory itself", async () => {
		const { agentDir, a } = makeProjectRoots();
		mkdirSync(join(a, "sub"), { recursive: true });
		writeFileSync(join(a, "sub", "alpha.ts"), "// a");

		// The tilde branch resolves against HOME at call time; point it at the
		// project root so ~ maps to a known directory. Regression: `~/sub/`
		// used to hit dirname("<home>/sub/") and list `~` filtered by "sub",
		// so accepting a directory completion duplicated its own name.
		const realHome = process.env.HOME;
		process.env.HOME = a;
		try {
			const { port } = await startDaemon({ agentDir, allow: [a] });
			const ws = await openClient(port);
			const frames = collectFrames(ws);
			const projectId = basename(a).toLowerCase();

			const ask = async (prefix: string) => {
				const id = send(ws, { verb: "listFiles", projectId, prefix });
				const reply = (await waitForReply(frames, id)) as unknown as {
					ok: boolean;
					entries: Array<{ path: string; isDirectory: boolean }>;
				};
				return reply.entries.map((e) => e.path);
			};

			// Accepted directory completion: refetch of `~/sub/` lists inside it.
			expect(await ask("~/sub/")).toEqual(["~/sub/alpha.ts"]);
			// Partial filter still completes the directory entry itself.
			expect(await ask("~/su")).toEqual(["~/sub"]);
			// Bare `~` completes entries under home with the `~/` prefix intact.
			expect(await ask("~")).toEqual(["~/sub"]);

			ws.close();
		} finally {
			process.env.HOME = realHome;
		}
	});

	it("getDaemonInfo reports each project's resolved default model", async () => {
		const { agentDir, root, a } = makeProjectRoots();
		// Project settings pin a default model and thinking level for project a.
		mkdirSync(join(a, ".pi"), { recursive: true });
		writeFileSync(
			join(a, ".pi", "settings.json"),
			JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-2", defaultThinkingLevel: "high" }),
		);

		const modelRuntime = await makeFauxRuntime();

		const { port } = await startDaemon({ agentDir, allow: [a], modelRuntime });
		const ws = await openClient(port);
		const frames = collectFrames(ws);

		const id = send(ws, { verb: "getDaemonInfo" });
		const reply = (await waitForReply(frames, id)) as unknown as {
			projects: Array<{
				id: string;
				defaultModel: { provider: string; modelId: string } | null;
				defaultThinkingLevel: string | null;
			}>;
		};
		const pid = basename(a).toLowerCase();
		const project = reply.projects.find((p) => p.id === pid);
		expect(project?.defaultModel).toEqual({ provider: "faux", modelId: "faux-2" });
		// The settings' level rides along with the same resolution.
		expect(project?.defaultThinkingLevel).toBe("high");

		// Without project settings the same runtime resolves to a per-provider
		// default or the first available model — never null while models exist.
		const bare = join(root, "bare");
		mkdirSync(bare);
		const { port: port2 } = await startDaemon({ agentDir, allow: [bare], modelRuntime });
		const ws2 = await openClient(port2);
		const frames2 = collectFrames(ws2);
		const id2 = send(ws2, { verb: "getDaemonInfo" });
		const reply2 = (await waitForReply(frames2, id2)) as unknown as {
			projects: Array<{
				id: string;
				defaultModel: { provider: string; modelId: string } | null;
				defaultThinkingLevel: string | null;
			}>;
		};
		expect(reply2.projects[0]?.defaultModel?.provider).toBe("faux");
		expect(["faux-1", "faux-2"]).toContain(reply2.projects[0]?.defaultModel?.modelId);
		// No settings default: pi's DEFAULT_THINKING_LEVEL.
		expect(reply2.projects[0]?.defaultThinkingLevel).toBe("medium");

		ws2.close();
		ws.close();
	});

	it("getDaemonInfo reports the global enabledModels scope, ignoring project overrides", async () => {
		const { agentDir, a } = makeProjectRoots();
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["faux-1"] }));
		// A project-level override exists but is deliberately not reported:
		// pinned models is one daemon-global concept (ADR 15), never per-Project.
		mkdirSync(join(a, ".pi"), { recursive: true });
		writeFileSync(join(a, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["faux-2"] }));

		const modelRuntime = await makeFauxRuntime();
		const { port } = await startDaemon({ agentDir, allow: [a], modelRuntime });
		const ws = await openClient(port);
		const frames = collectFrames(ws);

		const id = send(ws, { verb: "getDaemonInfo" });
		const reply = (await waitForReply(frames, id)) as unknown as {
			pinnedModels: Array<{ provider: string; id: string; name: string }>;
		};
		expect(reply.pinnedModels).toEqual([{ provider: "faux", id: "faux-1", name: expect.any(String) }]);

		ws.close();
	});

	it("getDaemonInfo resolves the bridge settings' visibleModels against the catalogue", async () => {
		const { agentDir, a } = makeProjectRoots();
		mkdirSync(join(agentDir, "bridge"), { recursive: true });
		writeFileSync(join(agentDir, "bridge", "settings.json"), JSON.stringify({ visibleModels: ["faux/*"] }));

		const modelRuntime = await makeFauxRuntime();
		const { port } = await startDaemon({ agentDir, allow: [a], modelRuntime });
		const ws = await openClient(port);
		const frames = collectFrames(ws);

		const id = send(ws, { verb: "getDaemonInfo" });
		const reply = (await waitForReply(frames, id)) as unknown as { visibleModels: string[] };
		expect(reply.visibleModels).toEqual(["faux/faux-1", "faux/faux-2"]);

		ws.close();
	});

	it("getDaemonInfo reports no visibleModels when the bridge settings file is absent", async () => {
		const { agentDir, a } = makeProjectRoots();
		const modelRuntime = await makeFauxRuntime();
		const { port } = await startDaemon({ agentDir, allow: [a], modelRuntime });
		const ws = await openClient(port);
		const frames = collectFrames(ws);

		const id = send(ws, { verb: "getDaemonInfo" });
		const reply = (await waitForReply(frames, id)) as unknown as { visibleModels: string[] };
		expect(reply.visibleModels).toEqual([]);

		ws.close();
	});

	it("setModelPinned writes the global enabledModels scope and broadcasts", async () => {
		const { agentDir, a } = makeProjectRoots();
		mkdirSync(agentDir, { recursive: true });
		const modelRuntime = await makeFauxRuntime();
		const { port } = await startDaemon({ agentDir, allow: [a], modelRuntime });
		const ws = await openClient(port);
		const frames = collectFrames(ws);

		await waitForReply(
			frames,
			send(ws, { verb: "setModelPinned", provider: "faux", modelId: "faux-1", pinned: true }),
		);
		const push = await waitForPush(frames, "pinned_models_changed");
		expect(push.pinnedModels).toEqual([{ provider: "faux", id: "faux-1", name: expect.any(String) }]);
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")).enabledModels).toEqual(["faux/faux-1"]);

		ws.close();
	});

	it("unpinning the last model clears the global scope", async () => {
		const { agentDir, a } = makeProjectRoots();
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["faux-1"] }));
		const modelRuntime = await makeFauxRuntime();
		const { port } = await startDaemon({ agentDir, allow: [a], modelRuntime });
		const ws = await openClient(port);
		const frames = collectFrames(ws);

		await waitForReply(
			frames,
			send(ws, { verb: "setModelPinned", provider: "faux", modelId: "faux-1", pinned: false }),
		);
		await waitForPush(frames, "pinned_models_changed");
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")).enabledModels).toBeUndefined();

		ws.close();
	});

	it("rejects duplicate ids and shared session storage at startup", async () => {
		const { agentDir, a } = makeProjectRoots();
		await expect(new Daemon().start({ agentDir, allow: [a, a] })).rejects.toThrow(/Duplicate project id/);
		// A Project id is the first URL path segment; a root asset of the same
		// name would win over the route and make the page unreachable.
		await expect(new Daemon().start({ agentDir, allow: [`assets=${a}`] })).rejects.toThrow(/reserved/);
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

		const id = send(ws, { verb: "newSession", projectId, text: "hello" });
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

	it("listActiveSessions previews the live document's latest message and activity", async () => {
		const { agentDir, a } = makeProjectRoots();
		const entries: Document["entries"] = {
			m1: {
				id: "m1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01Z",
				kind: "message",
				role: "user",
				content: [{ type: "text", text: "first prompt" }],
			},
			m2: {
				id: "m2",
				parentId: "m1",
				timestamp: "2026-01-01T00:00:02Z",
				kind: "message",
				role: "assistant",
				content: [{ type: "text", text: "latest reply" }],
			},
		};
		const factory: NonNullable<DaemonOptions["managerFactory"]> = async (opts) => {
			const stub = makeStubManager({ ...opts, entries, sessionId: "sess-live-preview" });
			stubs.set(stub.sessionId, stub);
			return stub.manager;
		};
		const { port } = await startDaemon({ agentDir, allow: [a], managerFactory: factory });
		const ws = await openClient(port);
		const frames = collectFrames(ws);
		const projectId = basename(a).toLowerCase();

		const id = send(ws, { verb: "newSession", projectId, text: "first prompt" });
		await waitForReply(frames, id);

		const listId = send(ws, { verb: "listActiveSessions" });
		const reply = (await waitForReply(frames, listId)) as unknown as {
			sessions: Array<{ firstMessageText?: string; lastMessageText?: string; lastActivityAt?: string }>;
		};
		expect(reply.sessions[0]?.firstMessageText).toBe("first prompt");
		expect(reply.sessions[0]?.lastMessageText).toBe("latest reply");
		expect(reply.sessions[0]?.lastActivityAt).toBe("2026-01-01T00:00:02Z");

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

		const first = (await waitForReply(
			frames,
			send(ws, { verb: "newSession", projectId, text: "one" }),
		)) as unknown as {
			session: SessionRef;
		};
		const second = (await waitForReply(
			frames,
			send(ws, { verb: "newSession", projectId, text: "two" }),
		)) as unknown as {
			session: SessionRef;
		};

		expect(first.session.stem).not.toBe(second.session.stem);
		expect(first.session.sessionId).not.toBe(second.session.sessionId);
		expect(factoryCalls).toBe(2);

		ws.close();
	});

	it("newSession admits the first prompt before the attach", async () => {
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
		const ws = await openClient(port);
		const frames = collectFrames(ws);
		const projectId = basename(a).toLowerCase();

		const id = send(ws, { verb: "newSession", projectId, text: "hello world" });
		const reply = (await waitForReply(frames, id)) as unknown as { ok: boolean; session: SessionRef };
		expect(reply.ok).toBe(true);
		// The initial sync the client navigates into follows the attach.
		await waitForPush(frames, "replace");

		const stub = stubRef.current;
		expect(stub).not.toBeNull();
		expect(stub!.handles.admittedTexts()).toEqual(["hello world"]);
		// Admission precedes the attach (ADR 12 slice): the daemon admits the
		// prompt, then attaches the connection.
		expect(stub!.handles.events()).toEqual(["admit", "attach"]);

		ws.close();
	});

	it("newSession applies the picked model and attachments before the admission", async () => {
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
		const ws = await openClient(port);
		const frames = collectFrames(ws);
		const projectId = basename(a).toLowerCase();
		const image = { type: "image", mimeType: "image/png", data: "aGk=" };

		const id = send(ws, {
			verb: "newSession",
			projectId,
			text: "look at this",
			images: [image],
			model: { provider: "p", modelId: "m" },
			thinkingLevel: "high",
		});
		const reply = (await waitForReply(frames, id)) as unknown as { ok: boolean; session: SessionRef };
		expect(reply.ok).toBe(true);

		const stub = stubRef.current!;
		// The model is applied first (the first turn runs on it), then the
		// thinking level, then the prompt with its attachments is admitted,
		// then the connection attaches into the already-streaming turn.
		expect(stub.handles.setModelCalls()).toEqual([{ provider: "p", modelId: "m" }]);
		expect(stub.handles.setThinkingLevelCalls()).toEqual(["high"]);
		expect(stub.handles.admittedCalls()).toEqual([{ text: "look at this", images: [image] }]);
		expect(stub.handles.events()).toEqual(["model", "level", "admit", "attach"]);

		ws.close();
	});

	it("an unknown newSession model disposes the fresh activation", async () => {
		const { agentDir, a } = makeProjectRoots();
		const { port, daemon } = await startDaemon({
			agentDir,
			allow: [a],
			managerFactory: async (opts) =>
				makeStubManager({
					...(opts ?? {}),
					setModelError: new Error("Model not found: p/m"),
				}).manager,
		});
		const ws = await openClient(port);
		const frames = collectFrames(ws);
		const projectId = basename(a).toLowerCase();

		const id = send(ws, { verb: "newSession", projectId, text: "hi", model: { provider: "p", modelId: "m" } });
		const reply = (await waitForReply(frames, id)) as unknown as { ok: boolean; error?: string };
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("Model not found");
		// Nothing survives: the activation was disposed, not left for idle GC.
		expect(daemon.listActiveSessions()).toHaveLength(0);

		ws.close();
	});

	it("a refused admission disposes the fresh activation", async () => {
		const { agentDir, a } = makeProjectRoots();
		let refuseAdmission = true;
		const { port, daemon } = await startDaemon({
			agentDir,
			allow: [a],
			managerFactory: async (opts) =>
				makeStubManager({
					...(opts ?? {}),
					admitError: refuseAdmission ? new Error("no model selected") : undefined,
				}).manager,
		});
		const ws = await openClient(port);
		const frames = collectFrames(ws);
		const projectId = basename(a).toLowerCase();

		const id = send(ws, { verb: "newSession", projectId, text: "hello" });
		const reply = (await waitForReply(frames, id)) as unknown as { ok: boolean; error?: string };
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("no model selected");
		// No empty session survives: the activation was disposed, not left for
		// idle GC.
		expect(daemon.listActiveSessions()).toHaveLength(0);

		// A later retry works (the address was released cleanly).
		refuseAdmission = false;
		const ws2 = await openClient(port);
		const frames2 = collectFrames(ws2);
		const retry = (await waitForReply(
			frames2,
			send(ws2, { verb: "newSession", projectId, text: "hello" }),
		)) as unknown as { ok: boolean };
		expect(retry.ok).toBe(true);
		ws2.close();

		ws.close();
	});

	it("rejects newSession without text", async () => {
		const { agentDir, a } = makeProjectRoots();
		const { port, daemon } = await startDaemon({ agentDir, allow: [a], managerFactory: stubMediator() });
		const ws = await openClient(port);
		const frames = collectFrames(ws);
		const projectId = basename(a).toLowerCase();

		const badFrames: Array<[Record<string, unknown>, RegExp]> = [
			[{ verb: "newSession", projectId }, /Missing `text`/],
			[{ verb: "newSession", projectId, text: "  " }, /Missing `text`/],
			// Malformed optional fields are rejected before anything is created.
			[{ verb: "newSession", projectId, text: "hi", images: "nope" }, /Invalid `images`/],
			[{ verb: "newSession", projectId, text: "hi", model: { provider: 1, modelId: "m" } }, /Invalid `model`/],
			[{ verb: "newSession", projectId, text: "hi", model: "p/m" }, /Invalid `model`/],
			[{ verb: "newSession", projectId, text: "hi", thinkingLevel: 42 }, /Invalid `thinkingLevel`/],
		];
		for (const [frame, errorRe] of badFrames) {
			const reply = (await waitForReply(frames, send(ws, frame))) as unknown as { ok: boolean; error?: string };
			expect(reply.ok).toBe(false);
			expect(reply.error).toMatch(errorRe);
		}
		// Nothing was created — text is a precondition, not an option.
		expect(daemon.listActiveSessions()).toHaveLength(0);

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

		expect((await waitForReply(frames, send(ws, { verb: "newSession", projectId, text: "hello" }))).ok).toBe(true);
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

describe("daemon: closeSession", () => {
	it("terminates the activation (even mid-stream), drops it from the active snapshot, and allows a fresh open", async () => {
		const { agentDir, a } = makeProjectRoots();
		let factoryCalls = 0;
		const { port } = await startDaemon({
			agentDir,
			allow: [a],
			managerFactory: async (opts) => {
				factoryCalls++;
				const stub = makeStubManager(opts ?? {});
				stubs.set(stub.sessionId, stub);
				return stub.manager;
			},
		});
		const projectId = basename(a).toLowerCase();
		const stem = writeSessionFile(a, agentDir, "kill-1");

		const ws = await openClient(port);
		const frames = collectFrames(ws);
		expect((await waitForReply(frames, send(ws, { verb: "openSession", projectId, stem }))).ok).toBe(true);
		const stub = [...stubs.values()][stubs.size - 1];
		expect(stub).toBeDefined();

		// A close is a kill, not a GC: mid-stream must not defer it.
		stub!.handles.setStreaming(true);
		const closeId = send(ws, { verb: "closeSession", projectId, stem });
		expect((await waitForReply(frames, closeId)).ok).toBe(true);
		expect(stub!.handles.disposed()).toBe(true);

		// The global snapshot drops the row; the history file survives.
		await waitFor(
			frames,
			(f) =>
				f.kind === "active_sessions_changed" &&
				!(f.sessions as Array<{ stem: string }>).some((s) => s.stem === stem),
		);
		expect(existsSync(join(sessionDirFor(a, agentDir), `${stem}.jsonl`))).toBe(true);

		// Closing again fails (nothing is active) and re-opening resumes fresh.
		expect((await waitForReply(frames, send(ws, { verb: "closeSession", projectId, stem }))).ok).toBe(false);
		expect((await waitForReply(frames, send(ws, { verb: "openSession", projectId, stem }))).ok).toBe(true);
		await waitForPush(frames, "replace");
		expect(factoryCalls).toBe(2);

		ws.close();
	});

	it("rejects unknown projects and never-active sessions", async () => {
		const { agentDir, a } = makeProjectRoots();
		const { port } = await startDaemon({ agentDir, allow: [a], managerFactory: stubMediator() });
		const projectId = basename(a).toLowerCase();
		writeSessionFile(a, agentDir, "kill-2");

		const ws = await openClient(port);
		const frames = collectFrames(ws);
		const unknownProject = (await waitForReply(
			frames,
			send(ws, { verb: "closeSession", projectId: "nope", stem: "anything" }),
		)) as unknown as RpcReply & { error?: string };
		expect(unknownProject.ok).toBe(false);
		expect(unknownProject.error).toContain("Unknown project");

		const inactive = await waitForReply(frames, send(ws, { verb: "closeSession", projectId, stem: "kill-2" }));
		expect(inactive.ok).toBe(false);

		ws.close();
	});

	it("severs attached connections without stalling the registry", async () => {
		const { agentDir, a } = makeProjectRoots();
		const { port } = await startDaemon({ agentDir, allow: [a], managerFactory: stubMediator() });
		const projectId = basename(a).toLowerCase();
		const stem1 = writeSessionFile(a, agentDir, "kill-3");
		const stem2 = writeSessionFile(a, agentDir, "kill-4");

		// Two connections share one activation; one kills it.
		const killer = await openClient(port);
		const killerFrames = collectFrames(killer);
		expect((await waitForReply(killerFrames, send(killer, { verb: "openSession", projectId, stem: stem1 }))).ok).toBe(
			true,
		);
		const victim = await openClient(port);
		const victimFrames = collectFrames(victim);
		expect((await waitForReply(victimFrames, send(victim, { verb: "openSession", projectId, stem: stem1 }))).ok).toBe(
			true,
		);

		expect(
			(await waitForReply(killerFrames, send(killer, { verb: "closeSession", projectId, stem: stem1 }))).ok,
		).toBe(true);

		// The still-"attached" victim can navigate away and detach afterwards:
		// the severed mapping must not arm GC on the disposed activation or
		// reject the switch.
		expect((await waitForReply(victimFrames, send(victim, { verb: "openSession", projectId, stem: stem2 }))).ok).toBe(
			true,
		);
		await waitForPush(victimFrames, "replace");
		expect((await waitForReply(victimFrames, send(victim, { verb: "detach" }))).ok).toBe(true);

		killer.close();
		victim.close();
	});
});

describe("daemon: archiveSession", () => {
	it("archives a dormant session: the file moves under the reserved prefix and leaves discovery", async () => {
		const { agentDir, a } = makeProjectRoots();
		const { port } = await startDaemon({ agentDir, allow: [a], managerFactory: stubMediator() });
		const projectId = basename(a).toLowerCase();
		const stem = writeSessionFile(a, agentDir, "arch-1");
		const dir = sessionDirFor(a, agentDir);

		const ws = await openClient(port);
		const frames = collectFrames(ws);
		const before = (await waitForReply(frames, send(ws, { verb: "listSessions", projectId }))) as unknown as {
			sessions: Array<{ stem: string }>;
		};
		expect(before.sessions.map((s) => s.stem)).toContain(stem);

		// No activation: the close is a no-op and only the move happens.
		expect((await waitForReply(frames, send(ws, { verb: "archiveSession", projectId, stem }))).ok).toBe(true);
		expect(existsSync(join(dir, `${stem}.jsonl`))).toBe(false);
		expect(existsSync(join(dir, ".archive", `${stem}.jsonl`))).toBe(true);

		// The Project push refreshes the page the row just left.
		await waitForPush(frames, "sessions_changed");
		const after = (await waitForReply(frames, send(ws, { verb: "listSessions", projectId }))) as unknown as {
			sessions: Array<{ stem: string }>;
		};
		expect(after.sessions.map((s) => s.stem)).not.toContain(stem);

		// Nothing is left to archive for that address.
		const again = (await waitForReply(
			frames,
			send(ws, { verb: "archiveSession", projectId, stem }),
		)) as unknown as RpcReply & { error?: string };
		expect(again.ok).toBe(false);
		expect(again.error).toContain("no file to archive");

		ws.close();
	});

	it("closes a live session before moving its file, even mid-stream", async () => {
		const { agentDir, a } = makeProjectRoots();
		const { port } = await startDaemon({ agentDir, allow: [a], managerFactory: stubMediator() });
		const projectId = basename(a).toLowerCase();
		const stem = writeSessionFile(a, agentDir, "arch-2");
		const dir = sessionDirFor(a, agentDir);

		const ws = await openClient(port);
		const frames = collectFrames(ws);
		expect((await waitForReply(frames, send(ws, { verb: "openSession", projectId, stem }))).ok).toBe(true);
		const stub = [...stubs.values()][stubs.size - 1];
		expect(stub).toBeDefined();
		stub!.handles.setStreaming(true);

		expect((await waitForReply(frames, send(ws, { verb: "archiveSession", projectId, stem }))).ok).toBe(true);
		expect(stub!.handles.disposed()).toBe(true);
		expect(existsSync(join(dir, ".archive", `${stem}.jsonl`))).toBe(true);
		await waitFor(
			frames,
			(f) =>
				f.kind === "active_sessions_changed" &&
				!(f.sessions as Array<{ stem: string }>).some((s) => s.stem === stem),
		);

		ws.close();
	});

	it("closes an unflushed session and reports that there was no file to archive", async () => {
		const { agentDir, a } = makeProjectRoots();
		const { port } = await startDaemon({ agentDir, allow: [a], managerFactory: stubMediator() });
		const projectId = basename(a).toLowerCase();

		const ws = await openClient(port);
		const frames = collectFrames(ws);
		const created = (await waitForReply(
			frames,
			send(ws, { verb: "newSession", projectId, text: "hello" }),
		)) as unknown as {
			session: SessionRef;
		};
		const reply = (await waitForReply(
			frames,
			send(ws, { verb: "archiveSession", projectId, stem: created.session.stem }),
		)) as unknown as RpcReply & { error?: string };
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("no file to archive");

		// The close is unconditional: the failed move does not skip it.
		const stub = [...stubs.values()][stubs.size - 1];
		expect(stub!.handles.disposed()).toBe(true);
		await waitFor(
			frames,
			(f) =>
				f.kind === "active_sessions_changed" &&
				!(f.sessions as Array<{ stem: string }>).some((s) => s.stem === created.session.stem),
		);

		ws.close();
	});

	it("never discovers an archived file and excludes it from the startup id-conflict scan", async () => {
		const { agentDir, a } = makeProjectRoots();
		const live = writeSessionFile(a, agentDir, "arch-dup");
		// A manual copy into the reserved prefix: same session id as the live
		// file, so a scan that enumerated the archive would hard-fail startup.
		const dir = sessionDirFor(a, agentDir);
		mkdirSync(join(dir, ".archive"), { recursive: true });
		writeSessionAt(join(dir, ".archive", "2026-01-01T00-00-00-000Z_arch-copy.jsonl"), "arch-dup", a);

		const { port } = await startDaemon({ agentDir, allow: [a], managerFactory: stubMediator() });
		const projectId = basename(a).toLowerCase();
		const ws = await openClient(port);
		const frames = collectFrames(ws);
		const page = (await waitForReply(frames, send(ws, { verb: "listSessions", projectId }))) as unknown as {
			sessions: Array<{ stem: string }>;
		};
		expect(page.sessions.map((s) => s.stem)).toEqual([live]);

		ws.close();
	});

	it("rejects the reserved archive stem and unknown projects", async () => {
		const { agentDir, a } = makeProjectRoots();
		const { port } = await startDaemon({ agentDir, allow: [a], managerFactory: stubMediator() });
		const projectId = basename(a).toLowerCase();
		const stem = writeSessionFile(a, agentDir, "arch-3");

		const ws = await openClient(port);
		const frames = collectFrames(ws);
		const unknown = (await waitForReply(
			frames,
			send(ws, { verb: "archiveSession", projectId: "nope", stem }),
		)) as unknown as RpcReply & { error?: string };
		expect(unknown.ok).toBe(false);
		expect(unknown.error).toContain("Unknown project");

		const reserved = (await waitForReply(
			frames,
			send(ws, { verb: "archiveSession", projectId, stem: `.archive/${stem}` }),
		)) as unknown as RpcReply & { error?: string };
		expect(reserved.ok).toBe(false);
		expect(reserved.error).toContain("reserved");

		ws.close();
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
		const newId = send(ws, { verb: "newSession", projectId, text: "hello" });
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

	it("reports the latest message and last activity from a durable file", async () => {
		const { agentDir, a } = makeProjectRoots();
		const stem = "2026-01-01T00-00-00-000Z_durable-latest";
		const file = join(sessionDirFor(a, agentDir), `${stem}.jsonl`);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(
			file,
			`${[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "durable-latest",
					timestamp: "2026-01-01T00:00:00Z",
					cwd: a,
				}),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2026-01-01T00:00:01Z",
					message: { role: "user", content: "first prompt", timestamp: 0 },
				}),
				JSON.stringify({
					type: "message",
					id: "m2",
					parentId: "m1",
					timestamp: "2026-01-01T00:00:02Z",
					message: { role: "assistant", content: [{ type: "text", text: "latest reply" }], timestamp: 0 },
				}),
				// A trailing tool result must not become the preview.
				JSON.stringify({
					type: "message",
					id: "m3",
					parentId: "m2",
					timestamp: "2026-01-01T00:00:03Z",
					message: {
						role: "toolResult",
						toolCallId: "t1",
						toolName: "read",
						content: [{ type: "text", text: "tool output" }],
						timestamp: 0,
					},
				}),
			].join("\n")}\n`,
		);

		const { port } = await startDaemon({ agentDir, allow: [a] });
		const ws = await openClient(port);
		const frames = collectFrames(ws);
		const projectId = basename(a).toLowerCase();

		const id = send(ws, { verb: "listSessions", projectId });
		const reply = (await waitForReply(frames, id)) as unknown as {
			sessions: Array<{
				stem: string;
				firstMessageText?: string;
				lastMessageText?: string;
				lastActivityAt?: string;
			}>;
		};
		const row = reply.sessions.find((s) => s.stem === stem);
		expect(row?.firstMessageText).toBe("first prompt");
		// The trailing tool result is skipped; the assistant reply is the preview.
		expect(row?.lastMessageText).toBe("latest reply");
		// Activity tracks every entry, including the tool result.
		expect(row?.lastActivityAt).toBe("2026-01-01T00:00:03Z");

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

		const rejected = await rawHttpRequest(port, "/assets/../../webx/secret.txt");
		expect(rejected.status).toBe(403);
		expect(rejected.body).not.toContain("secret");

		// Sanity: a real asset still serves.
		const ok = await rawHttpRequest(port, "/index.html");
		expect(ok.status).toBe(200);
	});
});
