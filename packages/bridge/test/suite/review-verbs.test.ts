// gitDiff (directive) + readFile (payload) — wire-level tests through a real
// Connection + WebSocket pair, using the real daemon-side runGitDiff /
// readFileAtSnapshot (the DaemonVerbs seam) and a real temporary git
// repository.
//
// The browser is split in two by role: `gitDiff` returns the directive (file
// list, statuses, counts, binary/rename flags) and never patch text; content
// comes from `readFile`, whose state grammar covers a pinned oid, "head", the
// staged "index", and "worktree". Both are absolutely addressed and
// attachment-free (ADR 14). Covers: commit↔commit and commit↔worktree
// directives, rename records, the head sentinel, empty diffs, binary flags,
// untracked listing + cap, invalid states, unreachable commits, content at
// commit/head/index/worktree, `absent` for a missing path, and the
// no-attachment path.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { Connection, type DaemonVerbs } from "../../src/host/connection.ts";
import { MAX_UNTRACKED_FILES, readFileAtSnapshot, runGitDiff } from "../../src/host/daemon.ts";
import { collectFrames, createWsPair, mockDaemonVerbs, mockSessionRef, waitForFrame } from "./conn-helpers.ts";
import type { BridgeHarness } from "./harness.ts";
import { createBridgeHarness } from "./harness.ts";

const FIXTURE_URL = new URL("../../../coding-agent/test/fixtures/before-compaction.jsonl", import.meta.url);

const reviewVerbs: DaemonVerbs = {
	...mockDaemonVerbs,
	gitDiff: (directory, oldState, newState) => runGitDiff(oldState, newState, directory),
	readFile: (path, state) => readFileAtSnapshot(path, state ?? "worktree"),
};

describe("gitDiff / readFile verbs", () => {
	const harnesses: BridgeHarness[] = [];

	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	async function withConnection(fn: (clientWs: WebSocket, frames: unknown[]) => Promise<void>): Promise<void> {
		const bh = await createBridgeHarness({ fixturePath: FIXTURE_URL.pathname, initGitRepo: true });
		harnesses.push(bh);
		const { serverWs, clientWs } = await createWsPair();
		const frames = collectFrames(clientWs);
		const conn = new Connection(serverWs, reviewVerbs, null, false);
		conn.attach(bh.manager, mockSessionRef);
		await waitForFrame(frames, (f) => (f as Record<string, unknown>).kind === "replace");
		try {
			await fn(clientWs, frames);
		} finally {
			serverWs.close();
			clientWs.close();
		}
	}

	async function call(
		clientWs: WebSocket,
		frames: unknown[],
		id: string,
		body: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		// Every wire-level directive here is scoped to the repository root; the
		// directory is part of the request (ADR 14) but not of what these tests
		// vary.
		const message =
			body.verb === "gitDiff" && body.directory === undefined ? { ...body, directory: harnesses[0]!.tempCwd } : body;
		clientWs.send(JSON.stringify({ id, ...message }));
		return (await waitForFrame(frames, (f) => (f as Record<string, unknown>).id === id)) as Record<string, unknown>;
	}

	/** Two commits: c1 = a.txt + b.txt, c2 = modify both. Returns their oids. */
	async function seedTwoCommits(): Promise<[string, string]> {
		const bh = harnesses[0]!;
		writeFileSync(join(bh.tempCwd, "a.txt"), "one\n");
		writeFileSync(join(bh.tempCwd, "b.txt"), "x\n");
		await bh.git("add", ".");
		await bh.git("commit", "-q", "-m", "c1");
		const c1 = await bh.git("rev-parse", "HEAD");
		writeFileSync(join(bh.tempCwd, "a.txt"), "one\ntwo\n");
		writeFileSync(join(bh.tempCwd, "b.txt"), "y\n");
		await bh.git("add", ".");
		await bh.git("commit", "-q", "-m", "c2");
		const c2 = await bh.git("rev-parse", "HEAD");
		return [c1, c2];
	}

	it("directs two commits: numstat files, no patch text", async () => {
		await withConnection(async (clientWs, frames) => {
			const [c1, c2] = await seedTwoCommits();
			const reply = await call(clientWs, frames, "r1", { verb: "gitDiff", old: c1, new: c2 });
			expect(reply.ok).toBe(true);
			expect(reply.patch).toBeUndefined();
			const files = reply.files as Array<{ path: string; additions: number; deletions: number; binary: boolean }>;
			expect(files.map((f) => f.path).sort()).toEqual(["a.txt", "b.txt"]);
			const a = files.find((f) => f.path === "a.txt")!;
			expect(a.additions).toBe(1);
			expect(a.deletions).toBe(0);
		});
	});

	it("reports a pure rename with oldPath", async () => {
		await withConnection(async (clientWs, frames) => {
			const bh = harnesses[0]!;
			writeFileSync(join(bh.tempCwd, "big.txt"), "l1\nl2\nl3\n");
			await bh.git("add", ".");
			await bh.git("commit", "-q", "-m", "add big");
			const before = await bh.git("rev-parse", "HEAD");
			await bh.git("mv", "big.txt", "renamed.txt");
			await bh.git("commit", "-q", "-m", "rename");
			const after = await bh.git("rev-parse", "HEAD");
			const reply = await call(clientWs, frames, "r2", { verb: "gitDiff", old: before, new: after });
			expect(reply.ok).toBe(true);
			const files = reply.files as Array<{ path: string; oldPath?: string; additions: number; deletions: number }>;
			expect(files).toEqual([
				{
					path: "renamed.txt",
					oldPath: "big.txt",
					status: "renamed",
					additions: 0,
					deletions: 0,
					binary: false,
				},
			]);
		});
	});

	it("directs a commit against the worktree, including the head sentinel", async () => {
		await withConnection(async (clientWs, frames) => {
			const [c1] = await seedTwoCommits();
			const bh = harnesses[0]!;
			writeFileSync(join(bh.tempCwd, "a.txt"), "one\ntwo\nthree\n");
			// c1 → worktree spans both commits plus the dirty edit: b.txt's c2
			// change is part of the window too.
			const fromC1 = await call(clientWs, frames, "r3a", { verb: "gitDiff", old: c1, new: "worktree" });
			expect(fromC1.ok).toBe(true);
			expect((fromC1.files as Array<{ path: string }>).map((f) => f.path).sort()).toEqual(["a.txt", "b.txt"]);
			// head → worktree sees only the dirty edit.
			const fromHead = await call(clientWs, frames, "r3b", { verb: "gitDiff", old: "head", new: "worktree" });
			expect(fromHead.ok).toBe(true);
			expect((fromHead.files as Array<{ path: string }>).map((f) => f.path)).toEqual(["a.txt"]);
		});
	});

	it("returns an empty directive for identical states", async () => {
		await withConnection(async (clientWs, frames) => {
			const [c1] = await seedTwoCommits();
			const reply = await call(clientWs, frames, "r5", { verb: "gitDiff", old: c1, new: c1 });
			expect(reply.ok).toBe(true);
			expect(reply.files).toEqual([]);
		});
	});

	it("flags binary files from - numstat counts", async () => {
		await withConnection(async (clientWs, frames) => {
			const bh = harnesses[0]!;
			writeFileSync(join(bh.tempCwd, "blob.bin"), "\x00\x01\x02");
			await bh.git("add", ".");
			await bh.git("commit", "-q", "-m", "bin");
			const before = await bh.git("rev-parse", "HEAD");
			writeFileSync(join(bh.tempCwd, "blob.bin"), "\x00\x01\x03");
			const reply = await call(clientWs, frames, "r6", { verb: "gitDiff", old: before, new: "worktree" });
			expect(reply.ok).toBe(true);
			const files = reply.files as Array<{ path: string; binary: boolean }>;
			expect(files).toEqual([
				{
					path: "blob.bin",
					oldPath: undefined,
					status: "modified",
					additions: 0,
					deletions: 0,
					binary: true,
				},
			]);
		});
	});

	it("replies ok:false for invalid states and unreachable commits", async () => {
		await withConnection(async (clientWs, frames) => {
			const [c1] = await seedTwoCommits();
			// "worktree" as the old state has no meaning (there is nothing to
			// diff the worktree against itself).
			expect((await call(clientWs, frames, "r8a", { verb: "gitDiff", old: "worktree", new: "head" })).ok).toBe(
				false,
			);
			// Revision expressions are rejected: only pinned oids and sentinels.
			expect((await call(clientWs, frames, "r8b", { verb: "gitDiff", old: "HEAD~1", new: c1 })).ok).toBe(false);
			expect((await call(clientWs, frames, "r8c", { verb: "gitDiff", old: "f".repeat(40), new: c1 })).ok).toBe(
				false,
			);
		});
	});

	it("reads a path at a pinned commit, and `absent` for a missing one", async () => {
		await withConnection(async (clientWs, frames) => {
			const [c1, c2] = await seedTwoCommits();
			const cwd = harnesses[0]!.tempCwd;
			const ok = await call(clientWs, frames, "r9a", { verb: "readFile", path: join(cwd, "a.txt"), state: c1 });
			expect(ok.ok).toBe(true);
			expect(ok.kind).toBe("file");
			expect(ok.content).toBe("one\n");
			expect(ok.truncated).toBe(false);
			// The historical version, not the worktree's.
			const old = await call(clientWs, frames, "r9b", {
				verb: "readFile",
				path: join(cwd, "a.txt"),
				state: c2,
			});
			expect(old.content).toBe("one\ntwo\n");
			// A path not in that commit's tree is a value, not an error.
			const missing = await call(clientWs, frames, "r9c", {
				verb: "readFile",
				path: join(cwd, "missing.txt"),
				state: c1,
			});
			expect(missing.ok).toBe(true);
			expect(missing.kind).toBe("absent");
			// An unreachable recorded commit is a real failure.
			expect(
				(
					await call(clientWs, frames, "r9d", {
						verb: "readFile",
						path: join(cwd, "a.txt"),
						state: "f".repeat(40),
					})
				).ok,
			).toBe(false);
		});
	});

	it("reads HEAD and the staged index", async () => {
		await withConnection(async (clientWs, frames) => {
			const [, c2] = await seedTwoCommits();
			const bh = harnesses[0]!;
			// Stage a new revision without committing it.
			writeFileSync(join(bh.tempCwd, "a.txt"), "one\ntwo\nstaged\n");
			await bh.git("add", "a.txt");
			const atHead = await call(clientWs, frames, "r14a", {
				verb: "readFile",
				path: join(bh.tempCwd, "a.txt"),
				state: "head",
			});
			expect(atHead.kind).toBe("file");
			expect(atHead.content).toBe("one\ntwo\n");
			const atIndex = await call(clientWs, frames, "r14b", {
				verb: "readFile",
				path: join(bh.tempCwd, "a.txt"),
				state: "index",
			});
			expect(atIndex.kind).toBe("file");
			expect(atIndex.content).toBe("one\ntwo\nstaged\n");
			// HEAD still resolves to c2's blob.
			expect(await bh.git("rev-parse", "HEAD")).toBe(c2);
		});
	});

	it("lists untracked files in a worktree directive, without counts", async () => {
		await withConnection(async (clientWs, frames) => {
			await seedTwoCommits();
			const bh = harnesses[0]!;
			writeFileSync(join(bh.tempCwd, "fresh.txt"), "new\nfile\n");
			writeFileSync(join(bh.tempCwd, "tab\tname.txt"), "tabbed\n");
			const reply = await call(clientWs, frames, "r11", { verb: "gitDiff", old: "head", new: "worktree" });
			expect(reply.ok).toBe(true);
			const files = reply.files as Array<{ path: string; additions: number; untracked?: boolean }>;
			// A tab inside a filename is part of the path, not a field separator.
			expect(files).toEqual([
				{ path: "fresh.txt", status: "added", additions: 0, deletions: 0, binary: false, untracked: true },
				{
					path: "tab\tname.txt",
					status: "added",
					additions: 0,
					deletions: 0,
					binary: false,
					untracked: true,
				},
			]);
		});
	});

	it("keeps a tracked filename containing a tab intact", async () => {
		await withConnection(async (clientWs, frames) => {
			const bh = harnesses[0]!;
			writeFileSync(join(bh.tempCwd, "tab\tname.txt"), "one\n");
			await bh.git("add", ".");
			await bh.git("commit", "-q", "-m", "tabbed");
			const before = await bh.git("rev-parse", "HEAD");
			writeFileSync(join(bh.tempCwd, "tab\tname.txt"), "one\ntwo\n");
			const reply = await call(clientWs, frames, "r12", { verb: "gitDiff", old: before, new: "worktree" });
			expect(reply.ok).toBe(true);
			expect(reply.files).toEqual([
				{
					path: "tab\tname.txt",
					oldPath: undefined,
					status: "modified",
					additions: 1,
					deletions: 0,
					binary: false,
				},
			]);
		});
	});

	it("caps untracked inclusion and reports the remainder", async () => {
		await withConnection(async (clientWs, frames) => {
			const bh = harnesses[0]!;
			for (let i = 0; i < MAX_UNTRACKED_FILES + 3; i++) {
				writeFileSync(join(bh.tempCwd, `u-${String(i).padStart(4, "0")}.txt`), "x\n");
			}
			const reply = await call(clientWs, frames, "r13", { verb: "gitDiff", old: "head", new: "worktree" });
			expect(reply.ok).toBe(true);
			const files = reply.files as Array<{ untracked?: boolean }>;
			expect(files.filter((f) => f.untracked)).toHaveLength(MAX_UNTRACKED_FILES);
			// The harness leaves its own untracked files in the cwd, so the total
			// comes from git rather than from the files this test wrote.
			const total = (await bh.git("ls-files", "--others", "--exclude-standard", "--full-name"))
				.split("\n")
				.filter(Boolean).length;
			expect(total).toBeGreaterThan(MAX_UNTRACKED_FILES);
			expect(reply.untrackedOmitted).toBe(total - MAX_UNTRACKED_FILES);
		});
	});

	it("addresses paths from the Project cwd, not the repository root", async () => {
		await withConnection(async () => {
			const bh = harnesses[0]!;
			// A Project whose cwd is a subdirectory of the repository root. git
			// reports repo-root-relative paths unless the diff is `--relative`, and
			// `readFile` resolves against the queried directory — if the two
			// disagree, every payload fetch comes back `absent` with a doubled path.
			const sub = join(bh.tempCwd, "sub");
			mkdirSync(sub, { recursive: true });
			writeFileSync(join(sub, "a.txt"), "one\n");
			await bh.git("add", "sub");
			await bh.git("commit", "-q", "-m", "sub: c1");
			const c1 = await bh.git("rev-parse", "HEAD");
			writeFileSync(join(sub, "a.txt"), "one\ntwo\n");
			await bh.git("add", "sub");
			await bh.git("commit", "-q", "-m", "sub: c2");
			const c2 = await bh.git("rev-parse", "HEAD");

			const directive = await runGitDiff(c1, c2, sub);
			expect(directive.files.map((f) => f.path)).toEqual(["a.txt"]);
			// The same directory-relative path resolves through the payload verb,
			// at a pinned commit and in the worktree.
			expect(await readFileAtSnapshot(join(sub, "a.txt"), c1)).toMatchObject({ kind: "file", content: "one\n" });
			expect(await readFileAtSnapshot(join(sub, "a.txt"), "worktree")).toMatchObject({
				kind: "file",
				content: "one\ntwo\n",
			});
			// Untracked listing uses the same base.
			writeFileSync(join(sub, "fresh.txt"), "new\n");
			const worktree = await runGitDiff("head", "worktree", sub);
			expect(worktree.files.map((f) => f.path)).toContain("fresh.txt");
		});
	});

	it("serves directives and reads with no attachment (ADR 14)", async () => {
		const bh = await createBridgeHarness({ fixturePath: FIXTURE_URL.pathname, initGitRepo: true });
		harnesses.push(bh);
		writeFileSync(join(bh.tempCwd, "a.txt"), "one\n");
		await bh.git("add", ".");
		await bh.git("commit", "-q", "-m", "c1");
		writeFileSync(join(bh.tempCwd, "a.txt"), "one\ntwo\n");

		const { serverWs, clientWs } = await createWsPair();
		const frames = collectFrames(clientWs);
		const conn = new Connection(serverWs, reviewVerbs, null, false);
		await new Promise((r) => clientWs.once("open", r));

		const dReply = await call(clientWs, frames, "r10a", { verb: "gitDiff", old: "head", new: "worktree" });
		expect(dReply.ok).toBe(true);
		expect((dReply.files as Array<{ path: string }>).map((f) => f.path)).toEqual(["a.txt"]);
		const fReply = await call(clientWs, frames, "r10b", {
			verb: "readFile",
			path: join(bh.tempCwd, "a.txt"),
			state: "worktree",
		});
		expect(fReply.ok).toBe(true);
		expect(fReply.content).toBe("one\ntwo\n");
		conn.dispose();
		serverWs.close();
		clientWs.close();
	});
});
