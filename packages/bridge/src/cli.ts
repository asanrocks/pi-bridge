// pi-bridge CLI entrypoint.
//
// Daemon (default):
//   pi-bridge [--port <port>] [--log <path>] [--dev] [--allow <[id=]dir>]...
//             [--web-root <dir>] [--agent-dir <dir>]
//             [--worker-socket <path>] [--worker-spawn [--worker-socket <path>]]
//
// Worker (the execution half as its own process):
//   pi-bridge --worker-serve --socket <path> [--allow <[id=]dir>]...
//             [--agent-dir <dir>] [--reserved-id <id>]...

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, type DaemonOptions } from "./host/index.ts";
import { runWorkerProcess } from "./host/worker-process.ts";
import { commit, date, piCore, version } from "./version.ts";

const USAGE = [
	"Usage:",
	"  pi-bridge [--port <port>] [--log <path>] [--dev] [--allow <[id=]dir>...] [--web-root <dir>]",
	"            [--agent-dir <dir>] [--worker-socket <path>] [--worker-spawn]",
	"  pi-bridge --worker-serve --socket <path> [--allow <[id=]dir>...] [--agent-dir <dir>]",
	"            [--reserved-id <id>...]",
].join("\n");

/** One Unix socket path inside a private temp directory: a Unix socket path is
 * length-limited, so it must not be derived from the user's cwd. */
function defaultWorkerSocket(): string {
	return join(mkdtempSync(join(tmpdir(), "pi-bridge-worker-")), "worker.sock");
}

async function main() {
	process.title = "pi-bridge";
	const args = process.argv.slice(2);
	const options: DaemonOptions = {};
	const allow: string[] = [];
	const reservedIds: string[] = [];
	let workerServe = false;
	let socketPath: string | undefined;
	let workerSocket: string | undefined;
	let workerSpawn = false;
	let agentDir: string | undefined;

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case "--port":
				options.port = parseInt(args[++i], 10);
				break;
			case "--log":
				options.logPath = args[++i];
				break;
			case "--dev":
				options.dev = true;
				break;
			case "--allow":
				allow.push(args[++i]);
				break;
			case "--web-root":
				options.webRoot = args[++i];
				break;
			case "--agent-dir":
				agentDir = args[++i];
				break;
			case "--worker-serve":
				workerServe = true;
				break;
			case "--socket":
				socketPath = args[++i];
				break;
			case "--reserved-id":
				reservedIds.push(args[++i]);
				break;
			case "--worker-socket":
				workerSocket = args[++i];
				break;
			case "--worker-spawn":
				workerSpawn = true;
				break;
			case "--version":
			case "-v":
				console.log(`pi-bridge ${version} (${commit}, ${date})`);
				console.log(`pi-core ${piCore}`);
				process.exit(0);
				break;
			case "--help":
			case "-h":
				console.log(USAGE);
				process.exit(0);
		}
	}

	if (workerServe) {
		await serveWorker({ allow, reservedIds, socketPath: socketPath ?? defaultWorkerSocket(), agentDir });
		return;
	}

	// Pass allow entries directly; defaults to [process.cwd()] in Daemon.start().
	if (allow.length > 0) options.allow = allow;
	if (agentDir !== undefined) options.agentDir = agentDir;

	// The Worker deployment. In-process is the default; an explicit socket or
	// spawn flag moves execution to its own process, which is the only mode
	// where Project storage is shared with another process.
	if (workerSocket !== undefined) {
		options.workerModes = [{ kind: "connect", endpoint: `unix:${workerSocket}` }];
	} else if (workerSpawn) {
		options.workerModes = [
			{
				kind: "spawn",
				allow: options.allow ?? [process.cwd()],
				socketPath: defaultWorkerSocket(),
			},
		];
	}

	const daemon = new Daemon();
	await daemon.start(options);

	const port = daemon.address?.port ?? 0;
	console.log(`pi-bridge listening on http://localhost:${port}/@latest`);

	const shutdown = async () => {
		await daemon.dispose();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

/** The Worker role: own Projects and runtimes, serve them on a socket, own no
 * browser protocol. Signals dispose the worker, so a supervisor can stop it
 * without leaving an exclusion claim behind. */
async function serveWorker(input: {
	allow: string[];
	reservedIds: string[];
	socketPath: string;
	agentDir: string | undefined;
}): Promise<void> {
	const worker = await runWorkerProcess({
		allow: input.allow.length > 0 ? input.allow : [process.cwd()],
		socketPath: input.socketPath,
		reservedProjectIds: input.reservedIds,
		...(input.agentDir !== undefined ? { agentDir: input.agentDir } : {}),
	});
	console.log(`pi-bridge worker serving on ${worker.endpoint}`);

	const shutdown = async () => {
		await worker.dispose();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((err) => {
	console.error("pi-bridge error:", err);
	process.exit(1);
});
