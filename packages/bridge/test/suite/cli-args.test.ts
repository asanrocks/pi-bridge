// CLI argument parsing: the role model is the contract, so the matrix is
// tested directly instead of through a spawned process.

import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../../src/cli-args.ts";

const SOCKET = "/tmp/pi-bridge-test.sock";

function parse(argv: string[]) {
	return parseCliArgs(argv, { socketPath: SOCKET });
}

function config(argv: string[]) {
	const parsed = parse(argv);
	if (parsed.kind !== "run") throw new Error(`expected a run config, got ${parsed.kind}`);
	return parsed.config;
}

function error(argv: string[]): string {
	const parsed = parse(argv);
	if (parsed.kind !== "error") throw new Error(`expected an error, got ${parsed.kind}`);
	return parsed.message;
}

describe("cli role model", () => {
	it("defaults to auto on the discovery socket", () => {
		const parsed = config([]);
		expect(parsed.mode).toBe("auto");
		expect(parsed.socketPath).toBe(SOCKET);
		expect(parsed.socketExplicit).toBe(false);
		expect(parsed.remoteDaemon).toBeNull();
	});

	it("accepts --mode=value and --mode value", () => {
		expect(config(["--mode=daemon"]).mode).toBe("daemon");
		expect(config(["--mode", "worker"]).mode).toBe("worker");
	});

	it("rejects an unknown or missing mode", () => {
		expect(error(["--mode=bogus"])).toContain("invalid --mode");
		expect(error(["--mode"])).toContain("invalid --mode");
	});

	it("treats --daemon as worker mode and refuses the daemon role", () => {
		const remote = config(["--daemon", "wss://example.test/bridge"]);
		expect(remote.mode).toBe("worker");
		expect(remote.remoteDaemon).toBe("wss://example.test/bridge");
		expect(error(["--mode=daemon", "--daemon", "ws://example.test"])).toContain("cannot be combined");
		expect(error(["--daemon", "https://example.test"])).toContain("ws:// or wss://");
	});

	it("keeps Project configuration and the web listener separate", () => {
		const parsed = config([
			"--allow",
			"alpha=/tmp/alpha",
			"--allow",
			"/tmp/beta",
			"--port",
			"33400",
			"--web-root",
			"/srv/web",
			"--log",
			"/tmp/trace.jsonl",
			"--dev",
			"--agent-dir",
			"/tmp/agent",
		]);
		expect(parsed.allow).toEqual(["alpha=/tmp/alpha", "/tmp/beta"]);
		expect(parsed.port).toBe(33400);
		expect(parsed.webRoot).toBe("/srv/web");
		expect(parsed.logPath).toBe("/tmp/trace.jsonl");
		expect(parsed.dev).toBe(true);
		expect(parsed.agentDir).toBe("/tmp/agent");
	});

	it("marks an explicit --socket so the child role cannot bind the default", () => {
		expect(config(["--socket", "/tmp/explicit.sock"]).socketExplicit).toBe(true);
		expect(config([]).socketExplicit).toBe(false);
	});

	it("rejects malformed values instead of ignoring them", () => {
		expect(error(["--port", "nope"])).toContain("invalid --port");
		expect(error(["--port"])).toContain("--port needs a value");
		expect(error(["--socket"])).toContain("--socket needs a value");
		expect(error(["--unknown"])).toContain("unknown argument");
		expect(error(["stray"])).toContain("unknown argument");
	});

	it("recognizes help and version as actions", () => {
		expect(parse(["--help"]).kind).toBe("help");
		expect(parse(["-h"]).kind).toBe("help");
		expect(parse(["--version"]).kind).toBe("version");
		expect(parse(["-v"]).kind).toBe("version");
	});
});
