// Spawn plumbing (commit 6 of the Worker split).
//
// `runWorkerProcess` and the Worker role are covered by their own modules; this
// test owns what only the Daemon's spawn mode does: start a child, wait until
// its socket answers, accept the registration it greets with, and stop it on
// dispose. The fixture is plain JavaScript so the test needs no build.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerEvent } from "../../src/host/worker-contract.ts";
import { createWorkerHost } from "../../src/host/worker-host.ts";

const fixtureEntry = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/worker-stub.mjs");

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

let pipeSeq = 0;

function tempSocket(): { socketPath: string } {
	if (process.platform === "win32") {
		pipeSeq += 1;
		return { socketPath: `\\\\.\\pipe\\pi-bridge-spawn-${process.pid}-${pipeSeq}` };
	}
	const dir = mkdtempSync(join(tmpdir(), "pi-bridge-spawn-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return { socketPath: join(dir, "worker.sock") };
}

describe("worker spawn mode", () => {
	it("starts the child, accepts its handshake, and stops it on dispose", async () => {
		const { socketPath } = tempSocket();
		const events: WorkerEvent[] = [];

		const host = await createWorkerHost({
			mode: { kind: "spawn", allow: ["alpha=/tmp/alpha"], socketPath, workerEntry: fixtureEntry },
			agentDir: "/tmp",
			reservedProjectIds: [],
			onEvent: (event) => events.push(event),
			onUnavailable: () => {},
			spawnTimeoutMs: 20_000,
		});
		cleanups.push(() => host.dispose());

		// The registration came from the child's greeting, not from local config.
		expect(host.info.projects.map((p) => p.id)).toEqual(["alpha"]);
		expect(host.endpoint).toBe(`unix:${socketPath}`);

		await host.dispose();
	});

	it("rejects a child whose registration the Daemon cannot route", async () => {
		const { socketPath } = tempSocket();
		await expect(
			createWorkerHost({
				mode: { kind: "spawn", allow: ["alpha=/tmp/alpha"], socketPath, workerEntry: fixtureEntry },
				agentDir: "/tmp",
				// The child advertises `alpha`, which the surface already owns.
				reservedProjectIds: ["alpha"],
				onEvent: () => {},
				onUnavailable: () => {},
				spawnTimeoutMs: 20_000,
			}),
		).rejects.toThrow(/reserved name/);
	});
});
