// Browser verbs end to end (ADR 14): a real Daemon, a real WebSocket, a real
// temporary git repository — and no attachment anywhere.
//
// The other browser tests drive the Connection with injected DaemonVerbs
// (mockDaemonVerbs + the real functions). This one closes the loop on the
// daemon's own wiring (`daemonVerbs.readFile` / `listDirectory` / `gitDiff`)
// and on the attachment-free routing: a client that never opens a Session can
// still list a directory, read a file at HEAD, and diff two states, because
// every query carries an absolute path.

import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Daemon } from "../../src/host/index.ts";
import { collectFrames, waitForFrame } from "./conn-helpers.ts";

describe("browser verbs through a real daemon", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
	});

	function makeTempDir(label: string): string {
		const dir = join(tmpdir(), `pi-bridge-browser-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		return dir;
	}

	/** A repository with `src/a.ts` committed, then modified in the worktree. */
	async function seedRepo(): Promise<{ dir: string; head: string }> {
		const dir = makeTempDir("repo");
		const run = async (...args: string[]): Promise<string> =>
			new Promise((resolve, reject) => {
				execFile("git", args, { cwd: dir }, (err, stdout) =>
					err ? reject(err) : resolve(stdout.toString().trim()),
				);
			});
		await run("init", "-q", "-b", "main");
		await run("config", "user.email", "bridge@test");
		await run("config", "user.name", "Bridge Test");
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
		await run("add", ".");
		await run("commit", "-q", "-m", "c1");
		const head = await run("rev-parse", "HEAD");
		writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
		writeFileSync(join(dir, "fresh.txt"), "untracked\n");
		return { dir, head };
	}

	it("lists, reads, and diffs with no Session attached", async () => {
		const { dir, head } = await seedRepo();
		const daemon = new Daemon();
		cleanups.push(() => void daemon.dispose());
		await daemon.start({ agentDir: makeTempDir("agent"), allow: [dir] });
		const addr = daemon.address;
		if (!addr) throw new Error("daemon not listening");

		const ws = new WebSocket(`ws://127.0.0.1:${addr.port}`);
		await new Promise<void>((resolve, reject) => {
			ws.on("open", () => resolve());
			ws.on("error", reject);
		});
		cleanups.push(() => ws.close());
		const frames = collectFrames(ws);

		const call = async (id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
			ws.send(JSON.stringify({ id, ...body }));
			return (await waitForFrame(frames, (f) => (f as Record<string, unknown>).id === id)) as Record<
				string,
				unknown
			>;
		};

		// 1. A live directory listing: the worktree, .git excluded, absolute
		//    child paths.
		const listing = await call("l1", { verb: "listDirectory", path: dir });
		expect(listing.ok).toBe(true);
		expect(listing.absent).toBe(false);
		const names = (listing.entries as Array<{ name: string }>).map((e) => e.name);
		expect(names).toContain("src");
		expect(names).toContain("fresh.txt");
		expect(names).not.toContain(".git");

		// 2. The same directory at HEAD, where the untracked file does not exist.
		const atHead = await call("l2", { verb: "listDirectory", path: dir, state: "head" });
		expect(atHead.ok).toBe(true);
		expect((atHead.entries as Array<{ name: string }>).map((e) => e.name)).toEqual(["src"]);

		// 3. File content: the worktree edit vs the committed blob.
		const live = await call("r1", { verb: "readFile", path: join(dir, "src", "a.ts") });
		expect(live.kind).toBe("file");
		expect(live.content).toBe("export const a = 2;\n");
		const committed = await call("r2", { verb: "readFile", path: join(dir, "src", "a.ts"), state: head });
		expect(committed.content).toBe("export const a = 1;\n");

		// 4. The directive: the dirty edit plus the untracked file, with statuses.
		const diff = await call("d1", { verb: "gitDiff", directory: dir, old: "head", new: "worktree" });
		expect(diff.ok).toBe(true);
		const files = diff.files as Array<{ path: string; status: string; untracked?: boolean }>;
		expect(files.find((f) => f.path === "src/a.ts")?.status).toBe("modified");
		expect(files.find((f) => f.path === "fresh.txt")).toMatchObject({ status: "added", untracked: true });

		// 5. A directory-scoped directive keeps paths relative to that directory.
		const scoped = await call("d2", { verb: "gitDiff", directory: join(dir, "src"), old: "head", new: "worktree" });
		expect((scoped.files as Array<{ path: string }>).map((f) => f.path)).toEqual(["a.ts"]);

		// 6. The commit review's base. HEAD here is the repository's root commit,
		//    so the host resolves the empty tree, and that oid is a usable diff
		//    state: every file in the commit is an add against it.
		const base = await call("b1", { verb: "gitBase", directory: dir, commit: head });
		expect(base.ok).toBe(true);
		const emptyTree = base.baseline as string;
		expect(emptyTree).toMatch(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
		const rootDiff = await call("d3", { verb: "gitDiff", directory: dir, old: emptyTree, new: head });
		expect((rootDiff.files as Array<{ path: string; status: string }>).map((f) => [f.path, f.status])).toEqual([
			["src/a.ts", "added"],
		]);

		// 7. An unreachable commit is a refusal, not an empty base.
		const bad = await call("b2", { verb: "gitBase", directory: dir, commit: "0".repeat(40) });
		expect(bad.ok).toBe(false);
	});
});
