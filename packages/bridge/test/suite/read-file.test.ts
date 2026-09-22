// readFile verb — wire-level tests through a real Connection + WebSocket pair,
// using the real daemon-side readFileAtSnapshot (the DaemonVerbs seam).
//
// ADR 14 addressing: the path is absolute (`~`-rooted is the one other
// accepted form), and the verb is attachment-free — no Session is needed to
// resolve it. Covers: absolute worktree reads, `absent` as a value (a missing
// path or a directory is not an error), binary detection, the byte cap /
// truncation flag, invalid states and relative paths, and the whole flow with
// no attachment at all. Commit- and index-state reads live in
// review-verbs.test.ts.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { Connection, type DaemonVerbs } from "../../src/host/connection.ts";
import { MAX_READ_FILE_BYTES, readFileAtSnapshot } from "../../src/host/daemon.ts";
import { collectFrames, createWsPair, mockDaemonVerbs, mockSessionRef, waitForFrame } from "./conn-helpers.ts";
import type { BridgeHarness } from "./harness.ts";
import { createBridgeHarness } from "./harness.ts";

const FIXTURE_URL = new URL("../../../coding-agent/test/fixtures/before-compaction.jsonl", import.meta.url);

/** daemonVerbs with the real readFileAtSnapshot implementation (mirrors Daemon wiring). */
const readFileVerbs: DaemonVerbs = {
	...mockDaemonVerbs,
	readFile: (path, state) => readFileAtSnapshot(path, state ?? "worktree"),
};

describe("readFile verb", () => {
	const harnesses: BridgeHarness[] = [];

	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	/** Harness with a file written into the manager's (temp) cwd and a
	 * connected Connection — attached by default, since the verb must not need
	 * the attachment. */
	async function withConnection(
		fn: (clientWs: WebSocket, frames: unknown[], managerCwd: string) => Promise<void>,
		attach = true,
	): Promise<void> {
		const bh = await createBridgeHarness({ fixturePath: FIXTURE_URL.pathname });
		harnesses.push(bh);
		writeFileSync(join(bh.manager.cwd, "hello.md"), "# Hello\n\nWorld\n");

		const { serverWs, clientWs } = await createWsPair();
		const frames = collectFrames(clientWs);
		const conn = new Connection(serverWs, readFileVerbs, null, false);
		if (attach) {
			conn.attach(bh.manager, mockSessionRef);
			await waitForFrame(frames, (f) => (f as Record<string, unknown>).kind === "replace");
		} else {
			await new Promise<void>((resolve) => clientWs.once("open", resolve));
		}

		try {
			await fn(clientWs, frames, bh.manager.cwd);
		} finally {
			conn.dispose();
			serverWs.close();
			clientWs.close();
		}
	}

	async function readViaRpc(
		clientWs: WebSocket,
		frames: unknown[],
		id: string,
		path: string,
		state?: string,
	): Promise<Record<string, unknown>> {
		clientWs.send(
			JSON.stringify(state === undefined ? { id, verb: "readFile", path } : { id, verb: "readFile", path, state }),
		);
		const reply = await waitForFrame(frames, (f) => {
			const r = f as Record<string, unknown>;
			return r.id === id && r.ok !== undefined;
		});
		return reply as Record<string, unknown>;
	}

	it("reads an absolute worktree path with no state given", async () => {
		await withConnection(async (clientWs, frames, managerCwd) => {
			const file = join(managerCwd, "hello.md");
			const reply = await readViaRpc(clientWs, frames, "1", file);
			expect(reply.ok).toBe(true);
			expect(reply.kind).toBe("file");
			expect(reply.state).toBe("worktree");
			expect(reply.content).toBe("# Hello\n\nWorld\n");
			expect(reply.truncated).toBe(false);
			expect(reply.path).toBe(file);
		});
	});

	it("serves the read with no attachment at all (the path is self-contained)", async () => {
		await withConnection(async (clientWs, frames, managerCwd) => {
			const reply = await readViaRpc(clientWs, frames, "1", join(managerCwd, "hello.md"));
			expect(reply.ok).toBe(true);
			expect(reply.content).toBe("# Hello\n\nWorld\n");
		}, false);
	});

	it("reports a missing path as `absent`, not a failure", async () => {
		await withConnection(async (clientWs, frames, managerCwd) => {
			const reply = await readViaRpc(clientWs, frames, "1", join(managerCwd, "no-such-file.md"));
			expect(reply.ok).toBe(true);
			expect(reply.kind).toBe("absent");
			expect(reply.state).toBe("worktree");
		});
	});

	it("reports a directory as `absent`", async () => {
		await withConnection(async (clientWs, frames, managerCwd) => {
			const reply = await readViaRpc(clientWs, frames, "1", managerCwd);
			expect(reply.ok).toBe(true);
			expect(reply.kind).toBe("absent");
		});
	});

	it("detects binary content from a NUL byte", async () => {
		await withConnection(async (clientWs, frames, managerCwd) => {
			writeFileSync(join(managerCwd, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00]));
			const reply = await readViaRpc(clientWs, frames, "1", join(managerCwd, "blob.bin"));
			expect(reply.ok).toBe(true);
			expect(reply.kind).toBe("binary");
			expect(reply.bytes).toBe(4);
		});
	});

	it("truncates oversized files and reports the full size", async () => {
		await withConnection(async (clientWs, frames, managerCwd) => {
			const big = join(managerCwd, "big.txt");
			writeFileSync(big, "a".repeat(MAX_READ_FILE_BYTES + 1024));
			const reply = await readViaRpc(clientWs, frames, "1", big);
			expect(reply.ok).toBe(true);
			expect(reply.kind).toBe("file");
			expect(reply.truncated).toBe(true);
			expect((reply.content as string).length).toBe(MAX_READ_FILE_BYTES);
			expect(reply.bytes).toBe(MAX_READ_FILE_BYTES + 1024);
		});
	});

	it("rejects an unknown snapshot state before any read", async () => {
		await withConnection(async (clientWs, frames, managerCwd) => {
			const reply = await readViaRpc(clientWs, frames, "1", join(managerCwd, "hello.md"), "HEAD~1");
			expect(reply.ok).toBe(false);
			expect(reply.error as string).toContain("Invalid snapshot state");
		});
	});

	it("rejects a relative path (absolute addressing is the contract)", async () => {
		await withConnection(async (clientWs, frames) => {
			const reply = await readViaRpc(clientWs, frames, "1", "hello.md");
			expect(reply.ok).toBe(false);
			expect(reply.error as string).toContain("Invalid path");
		});
	});
});
