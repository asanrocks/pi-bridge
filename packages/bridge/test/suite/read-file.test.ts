// readFile verb — wire-level tests through a real Connection + WebSocket
// pair, using the real daemon-side readHostFile (the DaemonVerbs seam).
// Covers: cwd-relative resolution, absolute paths, missing files, and the
// byte cap / truncation flag.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { Connection, type DaemonVerbs } from "../../src/host/connection.ts";
import { MAX_READ_FILE_BYTES, readHostFile } from "../../src/host/daemon.ts";
import { collectFrames, createWsPair, mockDaemonVerbs, mockSessionRef, waitForFrame } from "./conn-helpers.ts";
import type { BridgeHarness } from "./harness.ts";
import { createBridgeHarness } from "./harness.ts";

const FIXTURE_URL = new URL("../../../coding-agent/test/fixtures/before-compaction.jsonl", import.meta.url);

/** daemonVerbs with the real readFile implementation (mirrors Daemon wiring). */
const readFileVerbs: DaemonVerbs = {
	...mockDaemonVerbs,
	readFile: (path, cwd) => readHostFile(path, cwd ?? process.cwd()),
};

describe("readFile verb", () => {
	const harnesses: BridgeHarness[] = [];

	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	/** Harness with a file written into the manager's (temp) cwd and a
	 * connected, attached Connection. */
	async function withConnection(
		fn: (clientWs: WebSocket, frames: unknown[], managerCwd: string) => Promise<void>,
	): Promise<void> {
		const bh = await createBridgeHarness({ fixturePath: FIXTURE_URL.pathname });
		harnesses.push(bh);
		writeFileSync(join(bh.manager.cwd, "hello.md"), "# Hello\n\nWorld\n");

		const { serverWs, clientWs } = await createWsPair();
		const frames = collectFrames(clientWs);
		const conn = new Connection(serverWs, readFileVerbs, null, false);
		conn.attach(bh.manager, mockSessionRef);
		await waitForFrame(frames, (f) => (f as Record<string, unknown>).kind === "replace");

		try {
			await fn(clientWs, frames, bh.manager.cwd);
		} finally {
			serverWs.close();
			clientWs.close();
		}
	}

	async function readViaRpc(
		clientWs: WebSocket,
		frames: unknown[],
		id: string,
		path: string,
	): Promise<Record<string, unknown>> {
		clientWs.send(JSON.stringify({ id, verb: "readFile", path }));
		const reply = await waitForFrame(frames, (f) => {
			const r = f as Record<string, unknown>;
			return r.id === id && r.ok !== undefined;
		});
		return reply as Record<string, unknown>;
	}

	it("resolves relative paths against the attached instance cwd", async () => {
		await withConnection(async (clientWs, frames, managerCwd) => {
			const reply = await readViaRpc(clientWs, frames, "1", "hello.md");
			expect(reply.ok).toBe(true);
			expect(reply.content).toBe("# Hello\n\nWorld\n");
			expect(reply.truncated).toBe(false);
			expect(reply.path).toBe(join(managerCwd, "hello.md"));
		});
	});

	it("reads absolute paths regardless of cwd", async () => {
		await withConnection(async (clientWs, frames, managerCwd) => {
			const reply = await readViaRpc(clientWs, frames, "1", join(managerCwd, "hello.md"));
			expect(reply.ok).toBe(true);
			expect(reply.content).toBe("# Hello\n\nWorld\n");
			expect(reply.path).toBe(join(managerCwd, "hello.md"));
			expect(reply.bytes).toBe("# Hello\n\nWorld\n".length);
		});
	});

	it("returns ok:false with the error message for missing files", async () => {
		await withConnection(async (clientWs, frames) => {
			const reply = await readViaRpc(clientWs, frames, "1", "no-such-file.md");
			expect(reply.ok).toBe(false);
			expect(typeof reply.error).toBe("string");
		});
	});

	it("truncates oversized files and reports the full size", async () => {
		await withConnection(async (clientWs, frames, managerCwd) => {
			const big = join(managerCwd, "big.txt");
			writeFileSync(big, "a".repeat(MAX_READ_FILE_BYTES + 1024));
			const reply = await readViaRpc(clientWs, frames, "1", big);
			expect(reply.ok).toBe(true);
			expect(reply.truncated).toBe(true);
			expect((reply.content as string).length).toBe(MAX_READ_FILE_BYTES);
			expect(reply.bytes).toBe(MAX_READ_FILE_BYTES + 1024);
		});
	});

	it("requires an attached instance (relative paths have no base otherwise)", async () => {
		const { serverWs, clientWs } = await createWsPair();
		const frames = collectFrames(clientWs);
		const conn = new Connection(serverWs, readFileVerbs, null, false);
		await new Promise<void>((resolve) => clientWs.once("open", resolve));
		const reply = await readViaRpc(clientWs, frames, "1", "hello.md");
		expect(reply.ok).toBe(false);
		conn.dispose();
		serverWs.close();
		clientWs.close();
	});
});
