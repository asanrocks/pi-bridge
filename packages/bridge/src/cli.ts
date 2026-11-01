// pi-bridge CLI entrypoint.
//
// Roles:
//   auto (default)   join a running daemon as a Worker, or start a daemon that
//                    hosts a Worker in this process.
//   --mode=daemon    serve the web app and registered Workers only. Fails if the
//                    socket is already owned instead of changing roles.
//   --mode=worker    register this invocation's Projects with an existing
//                    daemon (the local socket by default).
//   --daemon <url>   register with a remote daemon (implies worker mode).
//
// Project configuration applies to the Worker; the web listener applies to the
// Daemon. A combined invocation hosts the shared daemon in the foreground, so
// exiting it disconnects other Workers' browsers while those Workers keep
// running.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliConfig, parseCliArgs } from "./cli-args.ts";
import { defaultDaemonSocketPath, probeDaemonSocket, removeStaleSocket } from "./host/daemon-socket.ts";
import { isSocketTaken, resolveStartupRole } from "./host/discovery.ts";
import { Daemon, type DaemonOptions } from "./host/index.ts";
import type { WorkerHostMode } from "./host/worker-host.ts";
import { runWorkerClient, runWorkerProcess } from "./host/worker-process.ts";
import { commit, date, piCore, version } from "./version.ts";

const USAGE = `Usage: pi-bridge [--mode=auto|daemon|worker] [--socket <path>] [--daemon <ws-url>]
                 [--allow <[id=]dir>]... [--port <port>] [--web-root <dir>]
                 [--log <path>] [--dev] [--agent-dir <dir>]

Options:
  --mode=auto|daemon|worker  Role to take (default: auto)
  --socket <path>            Daemon discovery socket (default: ~/.pi/bridge.sock)
  --daemon <ws-url>          Remote daemon to register with (implies worker mode)
  --allow <[id=]dir>         Project to serve (repeatable; worker role)
  --port <port>              Web listener port (daemon role)
  --web-root <dir>           Serve web assets from a directory
  --log <path>               Record WebSocket traffic as JSONL
  --dev                      Enable the browser console relay
  --agent-dir <dir>          pi agent directory for the Worker role
  -v, --version              Print versions
  -h, --help                 Print this help

Roles:
  auto     join a live daemon as a Worker, else start a daemon and host a Worker
  daemon   serve the web app and registered Workers only
  worker   register these Projects with an existing daemon, fail if none answers`;

/** One UNIX socket path inside a private temp directory: used only by the
 * internal spawn deployment, where the Daemon dials a child it started. A UNIX
 * socket path is length-limited, so it must not derive from the user's cwd. */
function spawnSocketPath(): string {
	return join(mkdtempSync(join(tmpdir(), "pi-bridge-worker-")), "worker.sock");
}

function fail(message: string): never {
	console.error(`pi-bridge: ${message}`);
	process.exit(1);
}

/** Install the one shutdown path. Returns a probe so a caller can tell a signal
 * from a terminal failure. */
function installShutdown(stop: () => Promise<void>): () => boolean {
	let stopping = false;
	const shutdown = (signal: string) => {
		if (stopping) return;
		stopping = true;
		void stop()
			.catch((err) => console.error(`pi-bridge: ${signal} shutdown failed:`, err))
			.finally(() => process.exit(0));
	};
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	return () => stopping;
}

async function main() {
	process.title = "pi-bridge";
	const parsed = parseCliArgs(process.argv.slice(2), { socketPath: defaultDaemonSocketPath() });
	if (parsed.kind === "error") fail(parsed.message);
	if (parsed.kind === "help") {
		console.log(USAGE);
		return;
	}
	if (parsed.kind === "version") {
		console.log(`pi-bridge ${version} (${commit}, ${date})`);
		console.log(`pi-core ${piCore}`);
		return;
	}
	const config = parsed.config;

	// Internal child role: serve this process's Projects on an explicit socket
	// for a Daemon that spawned it. Not part of the role model.
	if (config.workerServe) {
		if (!config.socketExplicit) fail("--worker-serve needs an explicit --socket");
		await serveWorker(config);
		return;
	}

	if (config.mode === "worker") {
		await joinDaemon(config, config.remoteDaemon ?? `unix:${config.socketPath}`);
		return;
	}

	if (config.mode === "auto") {
		const decision = await resolveStartupRole({
			probe: () => probeDaemonSocket(config.socketPath),
			removeStale: () => removeStaleSocket(config.socketPath),
		});
		if ("error" in decision) fail(decision.error);
		if (decision.role === "worker") {
			await joinDaemon(config, `unix:${config.socketPath}`);
			return;
		}
	} else {
		// Forced daemon: never fall back to another role.
		const probe = await probeDaemonSocket(config.socketPath);
		if (probe.kind === "live") {
			fail(`a daemon already owns ${config.socketPath}; join it with --mode=worker or stop it`);
		}
		if (probe.kind === "refused") fail(probe.reason);
		if (probe.kind === "stale") removeStaleSocket(config.socketPath);
	}

	await startDaemon(config);
}

/** The Worker deployment the Daemon hosts itself. */
function workerModesFor(config: CliConfig): WorkerHostMode[] | undefined {
	if (config.workerSpawn) {
		// Internal: run the execution half as a child process, so a crash or a
		// restart of the Daemon can be observed separately from its runtime.
		return [
			{
				kind: "spawn",
				allow: config.allow.length > 0 ? config.allow : [process.cwd()],
				socketPath: spawnSocketPath(),
			},
		];
	}
	// A forced daemon serves only the Workers that register with it. The default
	// (auto) hosts one in-process Worker over `--allow`.
	return config.mode === "daemon" ? [] : undefined;
}

async function startDaemon(config: CliConfig): Promise<void> {
	const options: DaemonOptions = {
		dev: config.dev,
		registrationSocketPath: config.socketPath,
		...(config.port !== undefined ? { port: config.port } : {}),
		...(config.webRoot !== undefined ? { webRoot: config.webRoot } : {}),
		...(config.logPath !== undefined ? { logPath: config.logPath } : {}),
		...(config.allow.length > 0 ? { allow: config.allow } : {}),
		...(config.agentDir !== undefined ? { agentDir: config.agentDir } : {}),
		...(workerModesFor(config) !== undefined ? { workerModes: workerModesFor(config) } : {}),
	};

	const daemon = new Daemon();
	try {
		await daemon.start(options);
	} catch (err) {
		await daemon.dispose().catch(() => {});
		// Losing the bind race is a role decision, not a failure: the winner owns
		// the socket, so this invocation joins it.
		if (config.mode === "auto" && isSocketTaken(err)) {
			await joinDaemon(config, `unix:${config.socketPath}`);
			return;
		}
		throw err;
	}

	reportDaemon(config, daemon);
	installShutdown(async () => {
		await daemon.dispose();
	});
}

/** Report the chosen role, the Web address a browser opens, and the socket a
 * Worker joins with. */
function reportDaemon(config: CliConfig, daemon: Daemon): void {
	console.log(`pi-bridge ${version} (${commit}, ${date})`);
	console.log("role: daemon");
	console.log(`daemon socket: ${config.socketPath}`);
	const hosted =
		config.mode === "daemon" ? "none (only registered Workers)" : config.workerSpawn ? "spawned" : "in-process";
	console.log(`worker: ${hosted}`);
	if (config.mode !== "daemon") {
		console.log("hosting: the shared daemon (exiting disconnects other workers' browsers)");
	}
	console.log(`web: http://localhost:${daemon.address?.port ?? 0}/`);
}

/**
 * Join a running daemon as its Worker. The first registration must succeed — an
 * explicit worker launch with no daemon is an error, not a retry loop. After
 * that a lost link is ridden out: the runtimes stay in this process, so an
 * admitted turn survives a daemon restart.
 */
async function joinDaemon(config: CliConfig, endpoint: string): Promise<void> {
	const worker = await runWorkerClient({
		allow: config.allow.length > 0 ? config.allow : [process.cwd()],
		endpoint,
		...(config.agentDir !== undefined ? { agentDir: config.agentDir } : {}),
		onLinkUp: (info) => {
			console.log(`pi-bridge ${version} (${commit}, ${date})`);
			console.log("role: worker");
			console.log(`daemon: ${endpoint}`);
			console.log(`projects: ${info.projects.map((project) => project.id).join(", ") || "(none)"}`);
		},
		onLinkLost: (error) => console.error(`pi-bridge: ${error.message}; retrying`),
	}).catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		fail(
			config.remoteDaemon !== null
				? `${message}`
				: `${message}; start one with \`pi-bridge --mode=daemon\` or run \`pi-bridge\` with no arguments`,
		);
	});

	const stopping = installShutdown(async () => {
		await worker.dispose();
	});
	await worker.closed;
	if (!stopping()) fail(`worker registration refused by ${endpoint}`);
}

/** The internal socket-serving child role: own Projects and runtimes, serve
 * them on the given socket, own no browser protocol. Signals dispose it, so a
 * supervisor can stop it without leaving an exclusion claim behind. */
async function serveWorker(config: CliConfig): Promise<void> {
	const worker = await runWorkerProcess({
		allow: config.allow.length > 0 ? config.allow : [process.cwd()],
		socketPath: config.socketPath,
		...(config.agentDir !== undefined ? { agentDir: config.agentDir } : {}),
	});
	console.log(`pi-bridge worker serving on ${worker.endpoint}`);
	installShutdown(async () => {
		await worker.dispose();
	});
}

main().catch((err) => {
	console.error("pi-bridge error:", err);
	process.exit(1);
});
