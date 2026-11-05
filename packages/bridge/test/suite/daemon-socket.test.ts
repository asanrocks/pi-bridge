// The daemon registration socket: one local address that a launcher probes and
// a Worker dials. Two properties matter here and nowhere else:
//
//   - the probe classifies what actually owns the path (absent, stale, a
//     non-socket, a compatible daemon), because every role decision depends on
//     it, and a stale file is removed only after proving it is a socket;
//   - a Worker that dialed in becomes a routed registration, and losing the
//     Daemon does not end its runtimes — a restarted Daemon re-registers the
//     same process.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Daemon } from "../../src/host/daemon.ts";
import {
	defaultDaemonSocketPath,
	probeDaemonSocket,
	removeStaleSocket,
	startDaemonSocket,
	webBaseUrlFromEndpoint,
} from "../../src/host/daemon-socket.ts";
import { buildProjects } from "../../src/host/projects.ts";
import { runWorkerClient, type WorkerClientProcess } from "../../src/host/worker-process.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function workdir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-bridge-socket-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function stubModelRuntime(): ModelRuntime {
	return {
		getAvailableSnapshot: () => [],
		getProvider: () => undefined,
		setProxyResolvers: () => {},
	} as unknown as ModelRuntime;
}

/** One Project directory with a durable Session header, so `listSessions` has a
 * row without any Manager being constructed. `dir` defaults to the id; pass a
 * distinct one to build two Projects that share an id but not a directory. */
function projectFixture(root: string, id: string, dir = id): { allow: string; sessionDir: string } {
	const projectRoot = join(root, dir);
	mkdirSync(projectRoot, { recursive: true });
	const [project] = buildProjects([`${id}=${projectRoot}`], root);
	if (project === undefined) throw new Error("project fixture missing");
	mkdirSync(project.sessionDir, { recursive: true });
	writeFileSync(
		join(project.sessionDir, "s1.jsonl"),
		`${JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: projectRoot })}\n`,
	);
	return { allow: `${id}=${projectRoot}`, sessionDir: project.sessionDir };
}

async function startDaemon(socketPath: string, agentDir: string): Promise<Daemon> {
	const daemon = new Daemon();
	cleanups.push(() => daemon.dispose());
	await daemon.start({ workerModes: [], registrationSocketPath: socketPath, agentDir });
	return daemon;
}

function waitFor(condition: () => boolean, what: string, timeout = 5_000): Promise<void> {
	return new Promise((resolve, reject) => {
		if (condition()) return resolve();
		const timer = setTimeout(() => {
			clearInterval(interval);
			reject(new Error(`timeout waiting for ${what}`));
		}, timeout);
		const interval = setInterval(() => {
			if (!condition()) return;
			clearTimeout(timer);
			clearInterval(interval);
			resolve();
		}, 20);
	});
}

function openClient(port: number): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		ws.once("open", () => resolve(ws));
		ws.once("error", reject);
	});
}

interface Reply {
	id?: string;
	ok?: boolean;
	error?: string;
	[key: string]: unknown;
}

/** One RPC over a browser socket, resolving on its reply. */
function rpc(ws: WebSocket, frame: Record<string, unknown>): Promise<Reply> {
	const id = `t${Math.random().toString(36).slice(2)}`;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			ws.off("message", onMessage);
			reject(new Error(`timeout waiting for ${String(frame.verb)}`));
		}, 5_000);
		const onMessage = (data: unknown): void => {
			const reply = JSON.parse(String(data)) as Reply;
			if (reply.id !== id) return;
			clearTimeout(timer);
			ws.off("message", onMessage);
			resolve(reply);
		};
		ws.on("message", onMessage);
		ws.send(JSON.stringify({ id, ...frame }));
	});
}

/** A UNIX socket file with no listener: bind in a child and let it exit, which
 * leaves the path behind exactly like a crashed daemon. */
async function abandonSocket(path: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			process.execPath,
			["-e", "require('node:net').createServer().listen(process.argv[1], () => process.exit(0))", path],
			{ stdio: "ignore" },
		);
		child.once("error", reject);
		child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`socket child exited ${code}`))));
	});
}

const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";

/** One non-ASCII code point, for the escaping and length cases. */
const CJK = "\u5f20";

/** Tests that bind or leave behind a UNIX socket file: Windows binds a named
 * pipe and the namespace entry vanishes with the process, so neither a plain
 * path is bindable nor is a stale file left to find. */
const itOnUnix = process.platform === "win32" ? it.skip : it;
const itOnWindows = process.platform === "win32" ? it : it.skip;

let pipeSeq = 0;

/** An address one test can actually bind: a file in its private temp directory
 * on a platform that binds paths, a process-unique pipe name on Windows, where
 * the pipe namespace is machine-global. */
function testSocketPath(root: string, name: string): string {
	if (process.platform !== "win32") return join(root, `${name}.sock`);
	pipeSeq += 1;
	return `${WINDOWS_PIPE_PREFIX}pi-bridge-${name}-${process.pid}-${pipeSeq}`;
}

/** Replace `process.platform` for one synchronous block, then put it back. */
function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	try {
		return run();
	} finally {
		if (descriptor !== undefined) Object.defineProperty(process, "platform", descriptor);
	}
}

describe("daemon socket probe", () => {
	it("reports an absent path", async () => {
		const root = workdir();
		await expect(probeDaemonSocket(join(root, "missing.sock"))).resolves.toEqual({ kind: "absent" });
	});

	it("reports a live daemon and does not register anything", async () => {
		const root = workdir();
		const socketPath = testSocketPath(root, "live");
		const daemon = await startDaemon(socketPath, root);

		// The probe is the only reply a daemon sends a launcher, so it is where a
		// joining Worker learns the address a browser should open.
		await expect(probeDaemonSocket(socketPath)).resolves.toEqual({ kind: "live", web: daemon.webUrl });
		expect(daemon.registrations).toHaveLength(0);
	});

	it("derives a remote daemon's browser address from its registration URL", () => {
		expect(webBaseUrlFromEndpoint("ws://box:33334")).toBe("http://box:33334");
		expect(webBaseUrlFromEndpoint("wss://box/bridge")).toBe("https://box");
		expect(webBaseUrlFromEndpoint("unix:/run/bridge.sock")).toBeNull();
		expect(webBaseUrlFromEndpoint("http://box")).toBeNull();
	});

	itOnUnix("reports a crashed daemon's socket as stale and removes only a socket", async () => {
		const root = workdir();
		const socketPath = join(root, "stale.sock");
		await abandonSocket(socketPath);

		await expect(probeDaemonSocket(socketPath)).resolves.toEqual({ kind: "stale" });
		removeStaleSocket(socketPath);
		expect(existsSync(socketPath)).toBe(false);
	});

	it("refuses a path that is not a UNIX socket and never removes it", async () => {
		const root = workdir();
		const file = join(root, "not-a-socket");
		writeFileSync(file, "hello");

		const probe = await probeDaemonSocket(file);
		expect(probe.kind).toBe("refused");
		expect("reason" in probe ? probe.reason : "").toContain("not a UNIX socket");
		expect(() => removeStaleSocket(file)).toThrow(/not a UNIX socket/);
		expect(existsSync(file)).toBe(true);
	});
});

describe("daemon socket default address", () => {
	it("names a file under $HOME where the platform has UNIX sockets", () => {
		withPlatform("linux", () => {
			expect(defaultDaemonSocketPath()).toBe(join(homedir(), ".pi", "bridge.sock"));
		});
	});

	it("names a per-user pipe on Windows, where a plain path is not bindable", () => {
		const windows = withPlatform("win32", () => defaultDaemonSocketPath());
		expect(windows.startsWith(WINDOWS_PIPE_PREFIX)).toBe(true);
		// The pipe namespace is machine-global: the address must separate users,
		// which is what $HOME does for the file default.
		expect(windows.length).toBeGreaterThan(`${WINDOWS_PIPE_PREFIX}pi-bridge-`.length);
		withPlatform("linux", () => expect(defaultDaemonSocketPath()).not.toBe(windows));

		// `ws` parses `ws+unix:` through `new URL()`, which percent-encodes
		// non-ASCII characters without decoding them and splits on `:`. Plain ASCII
		// names stay readable; non-ASCII or URL-special names are byte-escaped
		// without colliding.
		expect(withPlatform("win32", () => defaultDaemonSocketPath("alice"))).toBe(
			`${WINDOWS_PIPE_PREFIX}pi-bridge-alice`,
		);
		const cjk = withPlatform("win32", () => defaultDaemonSocketPath("张三"));
		const special = withPlatform("win32", () => defaultDaemonSocketPath("DOM\\a:b?c#d e_f"));
		const underscore = withPlatform("win32", () => defaultDaemonSocketPath("DOM_5ca_3ab_3fc_23d_20e_5ff"));
		for (const address of [cjk, special, underscore]) {
			const tail = address.slice(WINDOWS_PIPE_PREFIX.length);
			expect(tail).toMatch(/^pi-bridge-[0-9A-Za-z._-]+$/);
			expect(new URL(`ws+unix:${address}:/`).pathname).toBe(`${address}:/`);
		}
		expect(special).not.toBe(underscore);
	});

	it("shortens a name the pipe namespace cannot hold instead of failing bare", () => {
		// Escaping triples every non-ASCII byte, so a long account name can exceed
		// the 256-character pipe limit, where Windows answers the bind with the very
		// bare EACCES a wrong-shaped path gets — the failure this default exists to
		// explain away.
		const address = (name: string) => withPlatform("win32", () => defaultDaemonSocketPath(name));
		const first = address(`${CJK.repeat(30)}a`);
		const second = address(`${CJK.repeat(30)}b`);
		expect(first.length).toBeLessThanOrEqual(256);
		expect(first.slice(WINDOWS_PIPE_PREFIX.length)).toMatch(/^pi-bridge-[0-9A-Za-z._-]+$/);
		// A hash, not a cut: both names share their first 90 escaped characters, so
		// truncation alone would address one pipe for two accounts.
		expect(first).not.toBe(second);
		expect(new URL(`ws+unix:${first}:/`).pathname).toBe(`${first}:/`);
	});

	// Runs only where a pipe can actually be bound: it pins the address shape the
	// Windows default uses, end to end rather than by string.
	itOnWindows("binds a pipe name and refuses a plain path by name", async () => {
		const socketPath = defaultDaemonSocketPath(`张三-${process.pid}-${++pipeSeq}`);
		const socket = await startDaemonSocket({ socketPath, onWorker: () => {} });
		cleanups.push(() => socket.close());
		await expect(probeDaemonSocket(socketPath)).resolves.toEqual({ kind: "live", web: null });

		// libuv answers a non-pipe bind with a bare EACCES; the message must say
		// what the caller can change instead.
		const plain = join(workdir(), "plain-path");
		await expect(startDaemonSocket({ socketPath: plain, onWorker: () => {} })).rejects.toThrow(/named pipe/);
	});

	// Shortening is only correct if the shortened address still binds and dials; a
	// string assertion cannot show that.
	itOnWindows("binds a shortened over-long address", async () => {
		const socketPath = defaultDaemonSocketPath(`${CJK.repeat(40)}-${process.pid}-${++pipeSeq}`);
		const socket = await startDaemonSocket({ socketPath, onWorker: () => {} });
		cleanups.push(() => socket.close());
		await expect(probeDaemonSocket(socketPath)).resolves.toEqual({ kind: "live", web: null });
	});
});

describe("dial-in Worker registration", () => {
	it("routes a Worker that joined a daemon-only process", async () => {
		const root = workdir();
		const socketPath = testSocketPath(root, "dials-in");
		const fixture = projectFixture(root, "dials-in");
		const daemon = await startDaemon(socketPath, root);

		const worker = await runWorkerClient({
			allow: [fixture.allow],
			agentDir: root,
			endpoint: `unix:${socketPath}`,
			managerFactory: async () => {
				throw new Error("no Manager is needed for listing");
			},
			modelRuntime: stubModelRuntime(),
		});
		cleanups.push(() => worker.dispose());
		await waitFor(() => daemon.registrations.length === 1, "the Worker registration");

		const port = daemon.address?.port;
		if (port === undefined) throw new Error("daemon is not listening");
		const ws = await openClient(port);
		cleanups.push(() => ws.close());
		const info = await rpc(ws, { verb: "getDaemonInfo" });
		expect(info.ok).toBe(true);
		expect((info.projects as Array<{ id: string }>).map((project) => project.id)).toEqual(["dials-in"]);

		const page = await rpc(ws, { verb: "listSessions", projectId: "dials-in", max: 10 });
		expect(page.ok).toBe(true);
		expect((page.sessions as Array<{ stem: string }>).map((session) => session.stem)).toEqual(["s1"]);
	});

	it("keeps the Worker's runtimes across a daemon restart and re-registers", async () => {
		const root = workdir();
		const socketPath = testSocketPath(root, "survivor");
		const fixture = projectFixture(root, "survivor");
		const first = await startDaemon(socketPath, root);

		let links = 0;
		let lost = 0;
		const worker = await runWorkerClient({
			allow: [fixture.allow],
			agentDir: root,
			endpoint: `unix:${socketPath}`,
			managerFactory: async () => {
				throw new Error("no Manager is needed for listing");
			},
			modelRuntime: stubModelRuntime(),
			retryMinMs: 20,
			retryMaxMs: 50,
			onLinkUp: () => {
				links += 1;
			},
			onLinkLost: () => {
				lost += 1;
			},
		});
		cleanups.push(() => worker.dispose());
		await waitFor(() => first.registrations.length === 1, "the first registration");

		await first.dispose();
		// A lost link is not a crash: the Worker keeps serving its own process.
		await waitFor(() => lost === 1, "the link-loss notification");

		const second = await startDaemon(socketPath, root);
		await waitFor(() => second.registrations.length === 1, "the re-registration");
		expect(links).toBe(2);
	});

	it("stops a Worker whose registration the daemon refuses", async () => {
		const root = workdir();
		const socketPath = testSocketPath(root, "reserved");
		// `assets` is a reserved surface name, so the daemon rejects the claim.
		const fixture = projectFixture(root, "assets");
		const daemon = await startDaemon(socketPath, root);

		const worker: WorkerClientProcess = await runWorkerClient({
			allow: [fixture.allow],
			agentDir: root,
			endpoint: `unix:${socketPath}`,
			managerFactory: async () => {
				throw new Error("no Manager is needed for listing");
			},
			modelRuntime: stubModelRuntime(),
			retryMinMs: 20,
			retryMaxMs: 50,
		});
		cleanups.push(() => worker.dispose());

		// A refused registration is terminal: `closed` resolves instead of the
		// process reconnecting against a decision that cannot change.
		await worker.closed;
		expect(worker.worker.registration.id).toBeTruthy();
		expect(daemon.registrations).toHaveLength(0);
	});

	it("stops a Worker whose Project id another registration already serves", async () => {
		const root = workdir();
		const socketPath = testSocketPath(root, "clash");
		// The same Project id from two different directories: the Daemon's
		// routing conflict is under test, not the storage lock (which correctly
		// refuses the same directory to a second process).
		const one = projectFixture(root, "clash", "one");
		const two = projectFixture(root, "clash", "two");
		const daemon = await startDaemon(socketPath, root);

		const first = await runWorkerClient({
			allow: [one.allow],
			agentDir: root,
			endpoint: `unix:${socketPath}`,
			managerFactory: async () => {
				throw new Error("no Manager is needed for listing");
			},
			modelRuntime: stubModelRuntime(),
		});
		cleanups.push(() => first.dispose());
		await waitFor(() => daemon.registrations.length === 1, "the first registration");

		let links = 0;
		const second = await runWorkerClient({
			allow: [two.allow],
			agentDir: root,
			endpoint: `unix:${socketPath}`,
			managerFactory: async () => {
				throw new Error("no Manager is needed for listing");
			},
			modelRuntime: stubModelRuntime(),
			retryMinMs: 20,
			retryMaxMs: 50,
			onLinkUp: () => {
				links += 1;
			},
		});
		cleanups.push(() => second.dispose());

		// The refusal must carry the rejected close code, which makes it
		// terminal: a graceful close would read as a lost link, and this Worker
		// would reconnect against the same conflict forever — `closed` would
		// never resolve and `links` would climb without bound.
		await second.closed;
		expect(links).toBe(1);
		expect(daemon.registrations).toHaveLength(1);
	});
});
