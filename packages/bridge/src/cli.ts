// pi-bridge CLI entrypoint.
// Usage: pi-bridge [--port <port>] [--log <path>] [--dev] [--allow <[id=]dir>]... [--web-root <dir>]

import { Daemon, type DaemonOptions } from "./host/index.ts";
import { commit, date, version } from "./version.ts";

async function main() {
	process.title = "pi-bridge";
	const args = process.argv.slice(2);
	const options: DaemonOptions = {};
	const allow: string[] = [];

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
			case "--version":
			case "-v":
				console.log(`pi-bridge ${version} (${commit}, ${date})`);
				process.exit(0);
				break;
			case "--help":
			case "-h":
				console.log(
					"Usage: pi-bridge [--port <port>] [--log <path>] [--dev] [--allow <[id=]dir>...] [--web-root <dir>]",
				);
				process.exit(0);
		}
	}

	// Pass allow entries directly; defaults to [process.cwd()] in Daemon.start().
	if (allow.length > 0) {
		options.allow = allow;
	}

	const daemon = new Daemon();
	await daemon.start(options);

	const port = daemon.address?.port ?? 0;
	console.log(`pi-bridge listening on http://localhost:${port}`);

	// Keep alive
	process.on("SIGINT", async () => {
		await daemon.dispose();
		process.exit(0);
	});
	process.on("SIGTERM", async () => {
		await daemon.dispose();
		process.exit(0);
	});
}

main().catch((err) => {
	console.error("pi-bridge error:", err);
	process.exit(1);
});
