// Repository browser queries (ADR 14) — function-level tests for the
// absolute-path host layer: `listDirectory`, `readFileAtSnapshot`, and the
// reworked `runGitDiff` (statuses + the three-tree state matrix).
//
// These are the browser's three queries, exercised directly (no wire): live
// and snapshot directory listings, live and snapshot content reads, and diff
// directives over commit/head/index/worktree pairs with git's status letters.
// The wire verbs land in a later slice; the tests here pin the host contract
// they will expose.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	listDirectory,
	MAX_DIFF_FILES,
	readFileAtSnapshot,
	resolveGitBase,
	runGitDiff,
} from "../../src/host/daemon.ts";
import type { BridgeHarness } from "./harness.ts";
import { createBridgeHarness } from "./harness.ts";

const FIXTURE_URL = new URL("../../../coding-agent/test/fixtures/before-compaction.jsonl", import.meta.url);

describe("repository browser queries (ADR 14)", () => {
	const harnesses: BridgeHarness[] = [];
	const scratchDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
		while (scratchDirs.length) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
	});

	async function withRepo(fn: (bh: BridgeHarness) => Promise<void>, initGitRepo = true): Promise<void> {
		const bh = await createBridgeHarness({ fixturePath: FIXTURE_URL.pathname, initGitRepo });
		harnesses.push(bh);
		await fn(bh);
	}

	/** A directory outside any repository. */
	function outsideRepo(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-bridge-norepo-"));
		scratchDirs.push(dir);
		return dir;
	}

	/** Seeds `sub/a.txt`, `sub/b.txt` committed as c1, then edits both and
	 * commits c2. Returns the two oids and the absolute subdirectory. */
	async function seedCommits(bh: BridgeHarness): Promise<{ c1: string; c2: string; sub: string }> {
		const sub = join(bh.tempCwd, "sub");
		mkdirSync(sub, { recursive: true });
		writeFileSync(join(sub, "a.txt"), "one\n");
		writeFileSync(join(sub, "b.txt"), "x\n");
		await bh.git("add", "sub");
		await bh.git("commit", "-q", "-m", "c1");
		const c1 = await bh.git("rev-parse", "HEAD");
		writeFileSync(join(sub, "a.txt"), "one\ntwo\n");
		writeFileSync(join(sub, "b.txt"), "y\n");
		await bh.git("add", "sub");
		await bh.git("commit", "-q", "-m", "c2");
		const c2 = await bh.git("rev-parse", "HEAD");
		return { c1, c2, sub };
	}

	describe("readFileAtSnapshot", () => {
		it("reads the live worktree by absolute path and reports a missing file as absent", async () => {
			await withRepo(async (bh) => {
				const file = join(bh.tempCwd, "hello.md");
				writeFileSync(file, "# Hello\n");
				const read = await readFileAtSnapshot(file, "worktree");
				expect(read.kind).toBe("file");
				if (read.kind !== "file") return;
				expect(read.content).toBe("# Hello\n");
				expect(read.path).toBe(file);

				const missing = await readFileAtSnapshot(join(bh.tempCwd, "nope.md"), "worktree");
				expect(missing.kind).toBe("absent");
			});
		});

		it("distinguishes HEAD from the worktree and reads a pinned commit", async () => {
			await withRepo(async (bh) => {
				const { c1, sub } = await seedCommits(bh);
				const file = join(sub, "a.txt");
				// Uncommitted edit is visible only in the worktree.
				writeFileSync(file, "one\ntwo\nthree\n");
				const worktree = await readFileAtSnapshot(file, "worktree");
				const head = await readFileAtSnapshot(file, "head");
				const pinned = await readFileAtSnapshot(file, c1);
				expect(worktree.kind === "file" && worktree.content).toBe("one\ntwo\nthree\n");
				expect(head.kind === "file" && head.content).toBe("one\ntwo\n");
				expect(pinned.kind === "file" && pinned.content).toBe("one\n");
			});
		});

		it("reads the staged index, not the worktree", async () => {
			await withRepo(async (bh) => {
				const { sub } = await seedCommits(bh);
				const file = join(sub, "a.txt");
				writeFileSync(file, "staged\n");
				await bh.git("add", "sub/a.txt");
				writeFileSync(file, "unstaged\n");
				const index = await readFileAtSnapshot(file, "index");
				expect(index.kind === "file" && index.content).toBe("staged\n");
			});
		});

		it("reads the empty-tree baseline of a root-commit review as absent", async () => {
			await withRepo(async (bh) => {
				const { c1 } = await seedCommits(bh);
				// The empty tree a root-commit review compares against (ADR 14) is a
				// tree, not a commit: the old side of every added file must read as
				// `absent`, not throw. Derived from the root commit's own tree, never a
				// hardcoded sha1 constant.
				const root = await bh.git("rev-list", "--max-parents=0", "HEAD");
				const emptyTree = await bh.git("rev-parse", `${root}^{tree}`);
				const read = await readFileAtSnapshot(join(bh.tempCwd, "sub", "a.txt"), emptyTree);
				expect(read.kind).toBe("absent");
				// The same path at the commit itself still reads.
				expect(await readFileAtSnapshot(join(bh.tempCwd, "sub", "a.txt"), c1)).toMatchObject({
					kind: "file",
					content: "one\n",
				});
			});
		});

		it("reports a path outside a repository as absent for a snapshot state", async () => {
			const dir = outsideRepo();
			const file = join(dir, "plain.txt");
			writeFileSync(file, "plain\n");
			expect((await readFileAtSnapshot(file, "worktree")).kind).toBe("file");
			expect((await readFileAtSnapshot(file, "head")).kind).toBe("absent");
		});

		it("rejects a relative path and an unknown state", async () => {
			await withRepo(async (bh) => {
				await expect(readFileAtSnapshot("hello.md", "worktree")).rejects.toThrow("Invalid path");
				await expect(readFileAtSnapshot(join(bh.tempCwd, "x"), "bogus")).rejects.toThrow("Invalid snapshot state");
			});
		});
	});

	describe("listDirectory", () => {
		it("lists the live worktree: directories first, absolute paths, no .git", async () => {
			await withRepo(async (bh) => {
				const dir = join(bh.tempCwd, "tree");
				mkdirSync(join(dir, "nested"), { recursive: true });
				writeFileSync(join(dir, "z.txt"), "z\n");
				writeFileSync(join(dir, "a.txt"), "a\n");
				const listing = await listDirectory(dir, "worktree");
				expect(listing.absent).toBe(false);
				expect(listing.omitted).toBe(0);
				expect(listing.entries.map((e) => e.name)).toEqual(["nested", "a.txt", "z.txt"]);
				expect(listing.entries[0]).toEqual({ name: "nested", path: join(dir, "nested"), isDirectory: true });
				expect(listing.entries[1]).toEqual({ name: "a.txt", path: join(dir, "a.txt"), isDirectory: false });
			});
		});

		it("excludes .git and reports a missing directory as absent", async () => {
			await withRepo(async (bh) => {
				const listing = await listDirectory(bh.tempCwd, "worktree");
				expect(listing.entries.some((e) => e.name === ".git")).toBe(false);
				const missing = await listDirectory(join(bh.tempCwd, "gone"), "worktree");
				expect(missing.absent).toBe(true);
				expect(missing.entries).toEqual([]);
			});
		});

		it("lists a commit's tree, where an untracked file does not exist", async () => {
			await withRepo(async (bh) => {
				const { sub } = await seedCommits(bh);
				writeFileSync(join(sub, "untracked.txt"), "u\n");
				const listing = await listDirectory(sub, "head");
				expect(listing.absent).toBe(false);
				expect(listing.entries.map((e) => e.name)).toEqual(["a.txt", "b.txt"]);
				expect(listing.entries.every((e) => !e.isDirectory)).toBe(true);
				// Nested directories are reported as directories, not expanded.
				const root = await listDirectory(bh.tempCwd, "head");
				expect(root.entries.find((e) => e.name === "sub")?.isDirectory).toBe(true);
			});
		});

		it("lists the index, where a staged-but-uncommitted file exists", async () => {
			await withRepo(async (bh) => {
				const { sub } = await seedCommits(bh);
				mkdirSync(join(sub, "deep"), { recursive: true });
				writeFileSync(join(sub, "staged.txt"), "s\n");
				writeFileSync(join(sub, "deep", "nested.txt"), "n\n");
				await bh.git("add", "sub");
				const listing = await listDirectory(sub, "index");
				expect(listing.entries.map((e) => e.name)).toEqual(["deep", "a.txt", "b.txt", "staged.txt"]);
				expect(listing.entries[0]!.isDirectory).toBe(true);
				// Not in the commit's tree yet.
				const head = await listDirectory(sub, "head");
				expect(head.entries.some((e) => e.name === "staged.txt")).toBe(false);
			});
		});

		it("reports a directory missing from a tree as absent, and a non-repo path as absent", async () => {
			await withRepo(async (bh) => {
				const missing = await listDirectory(join(bh.tempCwd, "gone"), "head");
				expect(missing.absent).toBe(true);
				const dir = outsideRepo();
				expect((await listDirectory(dir, "head")).absent).toBe(true);
			});
		});

		it("rejects a relative path and an unknown state", async () => {
			await withRepo(async (bh) => {
				await expect(listDirectory("sub", "worktree")).rejects.toThrow("Invalid path");
				await expect(listDirectory(bh.tempCwd, "bogus")).rejects.toThrow("Invalid snapshot state");
			});
		});
	});

	describe("runGitDiff statuses and state matrix", () => {
		it("reports added, modified, deleted, and renamed statuses", async () => {
			await withRepo(async (bh) => {
				const { c1, sub } = await seedCommits(bh);
				writeFileSync(join(sub, "a.txt"), "one\ntwo\nthree\n"); // modified
				writeFileSync(join(sub, "added.txt"), "new\n"); // added
				rmSync(join(sub, "b.txt")); // deleted
				writeFileSync(join(sub, "renamed.txt"), "r\n");
				await bh.git("add", "sub");
				const { c2 } = await (async () => {
					await bh.git("commit", "-q", "-m", "c3");
					return { c2: await bh.git("rev-parse", "HEAD") };
				})();
				// A rename is only detected when the source still exists in the
				// base tree, so diff c1 against c3 with a genuine rename pair.
				const reply = await runGitDiff(c1, c2, sub);
				const byPath = new Map(reply.files.map((f) => [f.path, f]));
				expect(byPath.get("a.txt")?.status).toBe("modified");
				expect(byPath.get("added.txt")?.status).toBe("added");
				expect(byPath.get("b.txt")?.status).toBe("deleted");
			});
		});

		it("detects a rename with oldPath and the renamed status", async () => {
			await withRepo(async (bh) => {
				const sub = join(bh.tempCwd, "sub");
				mkdirSync(sub, { recursive: true });
				writeFileSync(join(sub, "big.txt"), "l1\nl2\nl3\nl4\nl5\n");
				await bh.git("add", "sub");
				await bh.git("commit", "-q", "-m", "add big");
				const before = await bh.git("rev-parse", "HEAD");
				await bh.git("mv", "sub/big.txt", "sub/renamed.txt");
				await bh.git("commit", "-q", "-m", "rename");
				const after = await bh.git("rev-parse", "HEAD");
				const reply = await runGitDiff(before, after, sub);
				expect(reply.files).toEqual([
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

		it("treats staged and unstaged edits as distinct index states", async () => {
			await withRepo(async (bh) => {
				const { sub } = await seedCommits(bh);
				writeFileSync(join(sub, "a.txt"), "staged\n");
				await bh.git("add", "sub/a.txt");
				writeFileSync(join(sub, "a.txt"), "staged\nunstaged\n");
				writeFileSync(join(sub, "fresh.txt"), "f\n"); // untracked

				const headToIndex = await runGitDiff("head", "index", sub);
				expect(headToIndex.files.map((f) => [f.path, f.status])).toEqual([["a.txt", "modified"]]);

				const indexToWorktree = await runGitDiff("index", "worktree", sub);
				// The unstaged edit to a.txt, plus the untracked file.
				expect(indexToWorktree.files.find((f) => f.path === "a.txt")?.status).toBe("modified");
				expect(indexToWorktree.files.find((f) => f.path === "fresh.txt")).toMatchObject({
					status: "added",
					untracked: true,
				});

				// index → head is the reverse of head → index.
				const indexToHead = await runGitDiff("index", "head", sub);
				expect(indexToHead.files.map((f) => [f.path, f.status])).toEqual([["a.txt", "modified"]]);
			});
		});

		it("scopes the directive to the given directory and makes paths relative to it", async () => {
			await withRepo(async (bh) => {
				const { c1, c2, sub } = await seedCommits(bh);
				// A change outside the subtree must not appear.
				writeFileSync(join(bh.tempCwd, "outside.txt"), "o\n");
				await bh.git("add", "outside.txt");
				await bh.git("commit", "-q", "-m", "outside");
				const c3 = await bh.git("rev-parse", "HEAD");
				const reply = await runGitDiff(c1, c3, sub);
				expect(reply.files.map((f) => f.path).sort()).toEqual(["a.txt", "b.txt"]);
				expect(reply.files.every((f) => !f.path.includes("/"))).toBe(true);
				// The same pair from the repository root sees the outside file.
				const rootReply = await runGitDiff(c1, c2, bh.tempCwd);
				expect(rootReply.files.some((f) => f.path === "sub/a.txt")).toBe(true);
			});
		});

		describe("resolveGitBase", () => {
			it("resolves a commit's first parent", async () => {
				await withRepo(async (bh) => {
					const { c1, c2 } = await seedCommits(bh);
					expect(await resolveGitBase(bh.tempCwd, c2)).toEqual({ baseline: c1 });
				});
			});

			it("resolves a root commit to the repository's empty tree", async () => {
				await withRepo(async (bh) => {
					const { c1 } = await seedCommits(bh);
					const root = await bh.git("rev-list", "--max-parents=0", "HEAD");
					// The harness's root commit is empty, so its tree *is* the empty tree —
					// the expectation is derived, never a hardcoded sha1 constant.
					const emptyTree = await bh.git("rev-parse", `${root}^{tree}`);
					expect(await resolveGitBase(bh.tempCwd, root)).toEqual({ baseline: emptyTree });
					// The base is a usable diff state: every file is an add against it.
					const reply = await runGitDiff(emptyTree, c1, bh.tempCwd);
					expect(reply.files.map((f) => [f.path, f.status])).toEqual([
						["sub/a.txt", "added"],
						["sub/b.txt", "added"],
					]);
				});
			});

			it("resolves a merge commit's first parent", async () => {
				await withRepo(async (bh) => {
					const { c2 } = await seedCommits(bh);
					await bh.git("checkout", "-q", "-b", "side");
					writeFileSync(join(bh.tempCwd, "side.txt"), "s\n");
					await bh.git("add", "side.txt");
					await bh.git("commit", "-q", "-m", "side");
					await bh.git("checkout", "-q", "main");
					writeFileSync(join(bh.tempCwd, "main.txt"), "m\n");
					await bh.git("add", "main.txt");
					await bh.git("commit", "-q", "-m", "main");
					const firstParent = await bh.git("rev-parse", "HEAD");
					await bh.git("merge", "-q", "--no-ff", "-m", "merge", "side");
					const merge = await bh.git("rev-parse", "HEAD");
					expect(merge).not.toBe(firstParent);
					expect(await resolveGitBase(bh.tempCwd, merge)).toEqual({ baseline: firstParent });
					expect(c2).not.toBe("");
				});
			});

			it("rejects an unreachable commit and a relative directory", async () => {
				await withRepo(async (bh) => {
					await expect(resolveGitBase(bh.tempCwd, "0".repeat(40))).rejects.toThrow("Unreachable commit");
					await expect(resolveGitBase(bh.tempCwd, "not-a-commit")).rejects.toThrow("Invalid commit");
					await expect(resolveGitBase("sub", "0".repeat(40))).rejects.toThrow("Invalid directory");
				});
			});
		});

		describe("the file-list cap", () => {
			it("caps the returned files and reports the omitted count", async () => {
				await withRepo(async (bh) => {
					const dir = join(bh.tempCwd, "many");
					mkdirSync(dir, { recursive: true });
					const total = MAX_DIFF_FILES + 5;
					const names = Array.from({ length: total }, (_, i) => `f${String(i).padStart(4, "0")}.txt`);
					for (const name of names) writeFileSync(join(dir, name), "x\n");
					await bh.git("add", "many");
					await bh.git("commit", "-q", "-m", "many");
					const base = await bh.git("rev-parse", "HEAD");
					for (const name of names) writeFileSync(join(dir, name), "y\n");

					const reply = await runGitDiff(base, "worktree", bh.tempCwd);
					// Untracked files (the harness's session file) are appended after the
					// cap; the capped set is the diffed files themselves.
					const diffed = reply.files.filter((f) => f.untracked !== true);
					expect(diffed).toHaveLength(MAX_DIFF_FILES);
					expect(reply.filesOmitted).toBe(5);
				});
			});

			it("omits the count when the whole list fits", async () => {
				await withRepo(async (bh) => {
					const { c1, c2 } = await seedCommits(bh);
					const reply = await runGitDiff(c1, c2, bh.tempCwd);
					expect(reply.files).toHaveLength(2);
					expect(reply.filesOmitted).toBeUndefined();
				});
			});
		});

		it("rejects invalid pairs and a relative directory", async () => {
			await withRepo(async (bh) => {
				await expect(runGitDiff("worktree", "head", bh.tempCwd)).rejects.toThrow("Invalid diff states");
				await expect(runGitDiff("index", "index", bh.tempCwd)).rejects.toThrow("Invalid diff states");
				await expect(runGitDiff("head", "worktree", "sub")).rejects.toThrow("Invalid directory");
			});
		});
	});
});
