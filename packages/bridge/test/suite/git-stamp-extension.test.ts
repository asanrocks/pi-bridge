import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { GIT_STAMP_CUSTOM_TYPE } from "../../src/core/git-stamp.ts";
import {
	createGitStampExtension,
	type GitRunner,
	type GitRunOptions,
	type GitRunResult,
} from "../../src/host/git-stamp-extension.ts";

const SHA1 = "0123456789abcdef0123456789abcdef01234567";
const SHA1_B = "fedcba9876543210fedcba9876543210fedcba98";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type Handler = (event: never, ctx: ExtensionContext) => Promise<void> | void;

function fakePi() {
	const handlers = new Map<string, Handler>();
	const appended: { customType: string; data: unknown }[] = [];
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		appendEntry: (customType: string, data?: unknown) => {
			appended.push({ customType, data });
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers, appended };
}

function fakeCtx(branch: unknown[] | (() => unknown[]) = [], signal?: AbortSignal): ExtensionContext {
	return {
		cwd: "/repo",
		signal,
		sessionManager: { getBranch: () => (typeof branch === "function" ? branch() : branch) },
	} as unknown as ExtensionContext;
}

function stampEntry(data: unknown): { type: "custom"; customType: string; data: unknown } {
	return { type: "custom", customType: GIT_STAMP_CUSTOM_TYPE, data };
}

const ok = (stdout: string): GitRunResult => ({ code: 0, stdout, killed: false });
const exit = (code: number): GitRunResult => ({ code, stdout: "", killed: false });
const killed = (): GitRunResult => ({ code: null, stdout: "", killed: true });

/** Scripted runner: `git rev-parse` and `git symbolic-ref` responses in order. */
function scriptedRunner(calls: GitRunResult[]): GitRunner {
	let i = 0;
	return async () => calls[i++] ?? exit(128);
}

/** Identity pair helper: [rev-parse result, symbolic-ref result]. */
const identity = (commit: GitRunResult, branch: GitRunResult): GitRunResult[] => [commit, branch];

async function runPrompt(handlers: Map<string, Handler>, ctx: ExtensionContext) {
	await handlers.get("message_start")!({ message: { role: "user" } } as never, ctx);
}

async function runTurnEnd(handlers: Map<string, Handler>, ctx: ExtensionContext) {
	await handlers.get("turn_end")!({ turnIndex: 0 } as never, ctx);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createGitStampExtension", () => {
	it("writes a baseline stamp on the first prompt observation", async () => {
		const { pi, handlers, appended } = fakePi();
		createGitStampExtension({ runGit: scriptedRunner(identity(ok(SHA1), ok("main"))) })(pi);
		await runPrompt(handlers, fakeCtx());
		expect(appended).toEqual([
			{
				customType: GIT_STAMP_CUSTOM_TYPE,
				data: { v: 1, anchor: "prompt", commit: SHA1, branch: "main" },
			},
		]);
	});

	it("does not duplicate an unchanged identity at turn_end", async () => {
		const { pi, handlers, appended } = fakePi();
		const runner = scriptedRunner(identity(ok(SHA1), ok("main")));
		createGitStampExtension({ runGit: runner })(pi);
		await runPrompt(handlers, fakeCtx());
		await runTurnEnd(handlers, fakeCtx([stampEntry({ v: 1, anchor: "prompt", commit: SHA1, branch: "main" })]));
		expect(appended).toHaveLength(1);
	});

	it("writes a turn_end transition when the identity changed during the turn", async () => {
		const { pi, handlers, appended } = fakePi();
		const runner = scriptedRunner(identity(ok(SHA1_B), ok("main")));
		createGitStampExtension({ runGit: runner })(pi);
		const ctx = fakeCtx([stampEntry({ v: 1, anchor: "prompt", commit: SHA1, branch: "main" })]);
		await runTurnEnd(handlers, ctx);
		expect(appended).toEqual([
			{
				customType: GIT_STAMP_CUSTOM_TYPE,
				data: { v: 1, anchor: "turn_end", commit: SHA1_B, branch: "main" },
			},
		]);
	});

	it("writes when only the branch changes", async () => {
		const { pi, handlers, appended } = fakePi();
		const runner = scriptedRunner(identity(ok(SHA1), ok("dev")));
		createGitStampExtension({ runGit: runner })(pi);
		const ctx = fakeCtx([stampEntry({ v: 1, anchor: "prompt", commit: SHA1, branch: "main" })]);
		await runPrompt(handlers, ctx);
		expect(appended).toHaveLength(1);
		expect(appended[0]!.data).toMatchObject({ commit: SHA1, branch: "dev" });
	});

	it("uses the last valid stamp on the active path as baseline (leaf to root)", async () => {
		const { pi, handlers, appended } = fakePi();
		const runner = scriptedRunner(identity(ok(SHA1_B), ok("main")));
		createGitStampExtension({ runGit: runner })(pi);
		const ctx = fakeCtx([
			stampEntry({ v: 1, anchor: "prompt", commit: SHA1, branch: "main" }),
			stampEntry({ v: 1, anchor: "turn_end", commit: SHA1_B, branch: "main" }),
		]);
		await runPrompt(handlers, ctx);
		expect(appended).toHaveLength(0);
	});

	it("ignores malformed and foreign stamps on the path", async () => {
		const { pi, handlers, appended } = fakePi();
		const runner = scriptedRunner(identity(ok(SHA1), ok("main")));
		createGitStampExtension({ runGit: runner })(pi);
		const ctx = fakeCtx([
			stampEntry({ v: 2, commit: SHA1_B, branch: "main" }), // future version — no baseline
			{ type: "custom", customType: "other.ext", data: { v: 1 } },
			stampEntry({ v: 1, anchor: "prompt", commit: "garbage", branch: "main" }), // malformed
		]);
		await runPrompt(handlers, ctx);
		// No parseable baseline → writes the observed identity.
		expect(appended).toHaveLength(1);
	});

	it("ignores non-user messages", async () => {
		const { pi, handlers, appended } = fakePi();
		let calls = 0;
		const runner: GitRunner = async () => {
			calls++;
			return ok(SHA1);
		};
		createGitStampExtension({ runGit: runner })(pi);
		await handlers.get("message_start")!({ message: { role: "assistant" } } as never, fakeCtx());
		await handlers.get("message_start")!({ message: { role: "custom" } } as never, fakeCtx());
		expect(calls).toBe(0);
		expect(appended).toHaveLength(0);
	});

	it("records unborn branch (null commit, named branch) and detached HEAD (commit, null branch)", async () => {
		const { pi, handlers, appended } = fakePi();
		const runner = scriptedRunner([
			...identity(exit(1), ok("main")), // unborn branch
			...identity(ok(SHA1), exit(1)), // detached HEAD
		]);
		createGitStampExtension({ runGit: runner })(pi);
		await runPrompt(handlers, fakeCtx());
		await runTurnEnd(handlers, fakeCtx([stampEntry({ v: 1, anchor: "prompt", commit: null, branch: "main" })]));
		expect(appended).toEqual([
			{ customType: GIT_STAMP_CUSTOM_TYPE, data: { v: 1, anchor: "prompt", commit: null, branch: "main" } },
			{ customType: GIT_STAMP_CUSTOM_TYPE, data: { v: 1, anchor: "turn_end", commit: SHA1, branch: null } },
		]);
	});

	it("writes nothing on observation failures and recovers on the next boundary", async () => {
		const { pi, handlers, appended } = fakePi();
		// Sequence: not-a-repo (128), timeout (killed), missing binary (code
		// null), then success.
		const runner = scriptedRunner([
			...identity(exit(128), exit(128)),
			...identity(killed(), ok("main")),
			...identity({ code: null, stdout: "", killed: false }, ok("main")),
			...identity(ok(SHA1), ok("main")),
		]);
		createGitStampExtension({ runGit: runner })(pi);
		const ctx = fakeCtx();
		await runPrompt(handlers, ctx);
		await runTurnEnd(handlers, ctx);
		await runPrompt(handlers, ctx);
		expect(appended).toHaveLength(0);
		await runTurnEnd(handlers, ctx);
		expect(appended).toHaveLength(1);
	});

	it("rejects malformed git output (writes nothing)", async () => {
		const { pi, handlers, appended } = fakePi();
		const runner = scriptedRunner([...identity(ok("not-a-hash"), ok("main")), ...identity(ok(SHA1), ok("a\nb"))]);
		createGitStampExtension({ runGit: runner })(pi);
		await runPrompt(handlers, fakeCtx());
		await runPrompt(handlers, fakeCtx());
		expect(appended).toHaveLength(0);
	});

	it("serializes observations and preserves enqueue order", async () => {
		const { pi, handlers, appended } = fakePi();
		const seen: string[] = [];
		const runner: GitRunner = async (args: string[]) => {
			seen.push(args[0]!);
			// Stagger resolution so a naive implementation interleaves.
			await new Promise((r) => setTimeout(r, args[0] === "rev-parse" ? 5 : 1));
			return args[0] === "rev-parse" ? ok(SHA1) : ok("main");
		};
		createGitStampExtension({ runGit: runner })(pi);
		// getBranch reflects appended entries, as the real session would.
		const ctx = fakeCtx(() => appended.map((a) => stampEntry(a.data)));
		// Two observations in flight concurrently; both must run in order and
		// the first must establish the baseline for the second.
		const p1 = handlers.get("message_start")!({ message: { role: "user" } } as never, ctx);
		const p2 = handlers.get("turn_end")!({ turnIndex: 0 } as never, ctx);
		await Promise.all([p1, p2]);
		expect(appended).toHaveLength(1);
		expect(seen).toEqual(["rev-parse", "symbolic-ref", "rev-parse", "symbolic-ref"]);
	});

	it("awaits the observation before the handler resolves (stamp precedes message persistence)", async () => {
		const { pi, handlers, appended } = fakePi();
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const runner: GitRunner = async () => {
			await gate;
			return ok(SHA1);
		};
		createGitStampExtension({ runGit: runner })(pi);
		let handlerDone = false;
		const done = runPrompt(handlers, fakeCtx()).then(() => {
			handlerDone = true;
		});
		await new Promise((r) => setTimeout(r, 1));
		expect(handlerDone).toBe(false);
		release();
		await done;
		expect(appended).toHaveLength(1);
	});

	it("passes cwd, timeout, and abort signal to the runner", async () => {
		const { pi, handlers } = fakePi();
		const seen: GitRunOptions[] = [];
		const runner: GitRunner = async (_args, options) => {
			seen.push(options);
			return ok(SHA1);
		};
		const controller = new AbortController();
		createGitStampExtension({ runGit: runner, timeoutMs: 250 })(pi);
		await runPrompt(handlers, fakeCtx([], controller.signal));
		expect(seen[0]).toMatchObject({ cwd: "/repo", timeoutMs: 250, signal: controller.signal });
	});
});
