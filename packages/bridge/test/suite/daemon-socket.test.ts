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
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Daemon } from "../../src/host/daemon.ts";
import { probeDaemonSocket, removeStaleSocket, webBaseUrlFromEndpoint } from "../../src/host/daemon-socket.ts";
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

describe("daemon socket probe", () => {
	it("reports an absent path", async () => {
		const root = workdir();
		await expect(probeDaemonSocket(join(root, "missing.sock"))).resolves.toEqual({ kind: "absent" });
	});

	it("reports a live daemon and does not register anything", async () => {
		const root = workdir();
		const socketPath = join(root, "bridge.sock");
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

	it("reports a crashed daemon's socket as stale and removes only a socket", async () => {
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

describe("dial-in Worker registration", () => {
	it("routes a Worker that joined a daemon-only process", async () => {
		const root = workdir();
		const socketPath = join(root, "bridge.sock");
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
		const socketPath = join(root, "bridge.sock");
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
		const socketPath = join(root, "bridge.sock");
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
		const socketPath = join(root, "bridge.sock");
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
