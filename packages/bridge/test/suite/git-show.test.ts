// gitShow verb — wire-level tests through a real Connection + WebSocket
// pair, using the real daemon-side runGitShow (the DaemonVerbs seam) and a
// real temporary git repository. Covers: stat output for a recorded commit,
// unreachable commits (ok:false), hash validation, and the missing-verb /
// unattached-instance guards.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { Connection, type DaemonVerbs } from "../../src/host/connection.ts";
import { runGitShow } from "../../src/host/daemon.ts";
import { collectFrames, createWsPair, mockDaemonVerbs, waitForFrame } from "./conn-helpers.ts";
import type { BridgeHarness } from "./harness.ts";
import { createBridgeHarness } from "./harness.ts";

const FIXTURE_URL = new URL("../../../coding-agent/test/fixtures/before-compaction.jsonl", import.meta.url);

const gitShowVerbs: DaemonVerbs = {
	...mockDaemonVerbs,
	gitShow: (commit, cwd) => runGitShow(commit, cwd ?? process.cwd()),
};

describe("gitShow verb", () => {
	const harnesses: BridgeHarness[] = [];

	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	async function withConnection(
		fn: (clientWs: WebSocket, frames: unknown[], commit: string) => Promise<void>,
	): Promise<void> {
		const bh = await createBridgeHarness({ fixturePath: FIXTURE_URL.pathname, initGitRepo: true });
		harnesses.push(bh);
		const commit = await bh.git("rev-parse", "HEAD");

		const { serverWs, clientWs } = await createWsPair();
		const frames = collectFrames(clientWs);
		const conn = new Connection(serverWs, gitShowVerbs, null, false);
		conn.attach(bh.manager, "test-mgr");
		await waitForFrame(frames, (f) => (f as Record<string, unknown>).kind === "replace");

		try {
			await fn(clientWs, frames, commit);
		} finally {
			serverWs.close();
			clientWs.close();
		}
	}

	async function callVerb(
		clientWs: WebSocket,
		frames: unknown[],
		id: string,
		commit: string,
	): Promise<Record<string, unknown>> {
		clientWs.send(JSON.stringify({ id, verb: "gitShow", commit }));
		return (await waitForFrame(frames, (f) => (f as Record<string, unknown>).id === id)) as Record<string, unknown>;
	}

	it("returns git show --stat output for a reachable commit", async () => {
		await withConnection(async (clientWs, frames, _initialCommit) => {
			// A real file commit so the diffstat has content.
			writeFileSync(join(harnesses[0]!.tempCwd, "file.txt"), "hello\n");
			await harnesses[0]!.git("add", "file.txt");
			await harnesses[0]!.git("commit", "-q", "-m", "add file.txt");
			const commit = await harnesses[0]!.git("rev-parse", "HEAD");
			const reply = await callVerb(clientWs, frames, "r1", commit);
			expect(reply.ok).toBe(true);
			expect(reply.truncated).toBe(false);
			expect(reply.output as string).toContain("add file.txt");
			expect(reply.output as string).toContain("1 file changed");
		});
	});

	it("replies ok:false for an unreachable commit", async () => {
		await withConnection(async (clientWs, frames) => {
			const ghost = "f".repeat(40);
			const reply = await callVerb(clientWs, frames, "r2", ghost);
			expect(reply.ok).toBe(false);
		});
	});

	it("replies ok:false for a non-hex commit (validation before spawn)", async () => {
		await withConnection(async (clientWs, frames) => {
			const reply = await callVerb(clientWs, frames, "r3", "HEAD; rm -rf /");
			expect(reply.ok).toBe(false);
			expect(reply.error as string).toContain("Invalid commit id");
		});
	});

	it("requires an attached instance", async () => {
		const { serverWs, clientWs } = await createWsPair();
		const frames = collectFrames(clientWs);
		// The Connection must exist to receive and reply to the frame.
		new Connection(serverWs, gitShowVerbs, null, false);
		await new Promise((r) => clientWs.once("open", r));
		clientWs.send(JSON.stringify({ id: "r4", verb: "gitShow", commit: "a".repeat(40) }));
		const reply = (await waitForFrame(frames, (f) => (f as Record<string, unknown>).id === "r4")) as Record<
			string,
			unknown
		>;
		expect(reply.ok).toBe(false);
		expect(reply.error as string).toContain("no instance attached");
		serverWs.close();
		clientWs.close();
	});
});

describe("runGitShow (unit)", () => {
	it("rejects malformed commit ids without spawning", async () => {
		await expect(runGitShow("abc123", process.cwd())).rejects.toThrow("Invalid commit id");
		await expect(runGitShow("", process.cwd())).rejects.toThrow("Invalid commit id");
		await expect(runGitShow(`A${"0".repeat(39)}`, process.cwd())).rejects.toThrow("Invalid commit id");
	});
});
