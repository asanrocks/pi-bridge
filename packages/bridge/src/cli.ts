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

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliConfig, parseCliArgs } from "./cli-args.ts";
import { type BannerInput, bannerLines } from "./cli-banner.ts";
import {
	defaultDaemonSocketPath,
	probeDaemonSocket,
	removeStaleSocket,
	webBaseUrlFromEndpoint,
} from "./host/daemon-socket.ts";
import { isSocketTaken, resolveStartupRole } from "./host/discovery.ts";
import { Daemon, type DaemonOptions } from "./host/index.ts";
import { bootstrapProcessTitle } from "./host/process-title.ts";
import type { WorkerHostMode } from "./host/worker-host.ts";
import { runWorkerClient, runWorkerProcess } from "./host/worker-process.ts";
import { commit, date, piCore, version } from "./version.ts";

const USAGE = `Usage: pi-bridge [--mode=auto|daemon|worker] [--socket <path>] [--daemon <ws-url>]
                 [--allow <[id=]dir>]... [--port <port>] [--web-root <dir>]
                 [--log <path>] [--dev] [--agent-dir <dir>] [--no-process-title]

Options:
  --mode=auto|daemon|worker  Role to take (default: auto)
  --socket <path>            Daemon discovery socket (default: ${defaultDaemonSocketPath()})
  --daemon <ws-url>          Remote daemon to register with (implies worker mode)
  --allow <[id=]dir>         Project to serve (repeatable; worker role)
  --port <port>              Web listener port (daemon role)
  --web-root <dir>           Serve web assets from a directory
  --log <path>               Record WebSocket traffic as JSONL
  --dev                      Enable the browser console relay
  --agent-dir <dir>          pi agent directory for the Worker role
  --no-process-title         Keep the process title fixed instead of reporting role
                             and Session state (see PI_BRIDGE_PROCESS_TITLE)
  -v, --version              Print versions
  -h, --help                 Print this help

Roles:
  auto     join a live daemon as a Worker, else start a daemon and host a Worker
  daemon   serve the web app and registered Workers only
  worker   register these Projects with an existing daemon, fail if none answers`;

/** One local socket address for the internal spawn deployment, where the Daemon
 * dials a child it started: a private temp-dir socket on UNIX (length-limited,
 * so never derived from cwd), or a unique named pipe on Windows. */
function spawnSocketPath(): string {
	if (process.platform === "win32") return `\\\\.\\pipe\\pi-bridge-worker-${process.pid}-${randomUUID()}`;
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
	// Before anything observable exists: the title may re-exec this process to
	// widen the writable window, and the title must not race real startup work.
	bootstrapProcessTitle({ enabled: config.processTitle });

	// Internal child role: serve this process's Projects on an explicit socket
	// for a Daemon that spawned it. Not part of the role model.
	if (config.workerServe) {
		if (!config.socketExplicit) fail("--worker-serve needs an explicit --socket");
		await serveWorker(config);
		return;
	}

	if (config.mode === "worker") {
		const remote = config.remoteDaemon;
		const endpoint = remote ?? `unix:${config.socketPath}`;
		await joinDaemon(
			config,
			endpoint,
			remote === null ? await probeWeb(config.socketPath) : webBaseUrlFromEndpoint(remote),
		);
		return;
	}

	if (config.mode === "auto") {
		const decision = await resolveStartupRole({
			probe: () => probeDaemonSocket(config.socketPath),
			removeStale: () => removeStaleSocket(config.socketPath),
		});
		if ("error" in decision) fail(decision.error);
		if (decision.role === "worker") {
			await joinDaemon(config, `unix:${config.socketPath}`, decision.web);
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
	const workerModes = workerModesFor(config);
	const options: DaemonOptions = {
		dev: config.dev,
		registrationSocketPath: config.socketPath,
		...(config.port !== undefined ? { port: config.port } : {}),
		...(config.webRoot !== undefined ? { webRoot: config.webRoot } : {}),
		...(config.logPath !== undefined ? { logPath: config.logPath } : {}),
		...(config.allow.length > 0 ? { allow: config.allow } : {}),
		...(config.agentDir !== undefined ? { agentDir: config.agentDir } : {}),
		...(workerModes !== undefined ? { workerModes } : {}),
	};

	const daemon = new Daemon();
	try {
		await daemon.start(options);
	} catch (err) {
		await daemon.dispose().catch(() => {});
		// Losing the bind race is a role decision, not a failure: the winner owns
		// the socket, so this invocation joins it.
		if (config.mode === "auto" && isSocketTaken(err)) {
			await joinDaemon(config, `unix:${config.socketPath}`, await probeWeb(config.socketPath));
			return;
		}
		throw err;
	}

	reportDaemon(config, daemon);
	installShutdown(async () => {
		await daemon.dispose();
	});
}

/** The Daemon's browser base URL, or null. Best effort: the registration that
 * follows reports the real error, so a failed probe must not end the launch. */
async function probeWeb(socketPath: string): Promise<string | null> {
	const probe = await probeDaemonSocket(socketPath).catch(() => null);
	return probe !== null && probe.kind === "live" ? probe.web : null;
}

function reportBanner(info: BannerInput): void {
	for (const line of bannerLines(info)) console.log(line);
}

function reportDaemon(config: CliConfig, daemon: Daemon): void {
	reportBanner({
		role: `${config.mode === "daemon" ? "daemon" : "daemon+worker"} (socket unix:${config.socketPath})`,
		projects: daemon.projectIds,
		web: daemon.webUrl,
		...(config.mode === "daemon"
			? {}
			: { note: "Note: this process hosts the shared daemon; exiting disconnects other Workers' browsers." }),
	});
}

/**
 * Join a running daemon as its Worker. The first registration must succeed — an
 * explicit worker launch with no daemon is an error, not a retry loop. After
 * that a lost link is ridden out: the runtimes stay in this process, so an
 * admitted turn survives a daemon restart.
 */
async function joinDaemon(config: CliConfig, endpoint: string, web: string | null): Promise<void> {
	// The banner is a startup fact, not a per-link one: a reconnect gets one line
	// so a flapping daemon cannot bury the terminal in identical headers.
	let announced = false;
	const worker = await runWorkerClient({
		allow: config.allow.length > 0 ? config.allow : [process.cwd()],
		endpoint,
		...(config.agentDir !== undefined ? { agentDir: config.agentDir } : {}),
		onLinkUp: (info) => {
			if (announced) {
				console.log(`pi-bridge: reconnected to ${endpoint}`);
				return;
			}
			announced = true;
			reportBanner({
				role: `worker (connected to ${endpoint})`,
				projects: info.projects.map((project) => project.id),
				web,
			});
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
