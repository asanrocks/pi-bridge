// Git-stamp observation drain — the terminal leg of the observation scope.
// `end()` stops admission synchronously and resolves only after every queued
// observation settled, so no `git` spawn starts after a Manager's dispose()
// resolves and a fire-and-forget trigger observation cannot outlive the
// runtime it appends to (F4).

import { describe, expect, it } from "vitest";
import type { GitRunResult, GitStampObserveContext } from "../../src/host/git-stamp-extension.ts";
import { createGitStampExtensionWithTrigger } from "../../src/host/git-stamp-extension.ts";

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A runGit whose first invocation is gated by the test. */
function gatedRunner(): {
	runner: (args: string[], options: { cwd: string; timeoutMs: number }) => Promise<GitRunResult>;
	calls: string[][];
	release: () => void;
} {
	const calls: string[][] = [];
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let opened = false;
	return {
		calls,
		release,
		runner: async (args) => {
			calls.push(args);
			if (!opened) {
				opened = true;
				await gate;
			}
			// Unborn HEAD: exit code 1 is meaningful, and a null/null identity
			// is valid — the observation completes (no stamp written).
			return { code: 1, stdout: "", killed: false };
		},
	};
}

/** The context slice an observation needs (the real one is pi's). */
const CTX: GitStampObserveContext = { cwd: "/repo", sessionManager: { getBranch: () => [] } };

describe("git-stamp observation drain", () => {
	it("end() resolves only after the queued observation settles", async () => {
		const { runner, release } = gatedRunner();
		const bundle = createGitStampExtensionWithTrigger({ runGit: runner, timeoutMs: 1000 });
		// Bind the factory the way the runtime does.
		bundle.factory({ appendEntry: () => {}, on: () => {} } as never);

		bundle.trigger.observe("user_bash_end", CTX);
		let ended = false;
		const ending = bundle.end().then(() => {
			ended = true;
		});
		await tick();
		// The observation is queued and gated: the drain must not resolve.
		expect(ended).toBe(false);

		release();
		await ending;
		expect(ended).toBe(true);
	});

	it("no observation starts after end() resolved", async () => {
		const { runner, calls, release } = gatedRunner();
		const bundle = createGitStampExtensionWithTrigger({ runGit: runner, timeoutMs: 1000 });
		bundle.factory({ appendEntry: () => {}, on: () => {} } as never);

		// One observation, ungated after the first call, then end.
		bundle.trigger.observe("user_bash_end", CTX);
		release();
		await bundle.end();
		const settled = calls.length;
		expect(settled).toBeGreaterThanOrEqual(3); // rev-parse + symbolic-ref + log

		// A late trigger observation admits nothing: the scope is closed and
		// the rejection is swallowed (the trigger is fire-and-forget).
		bundle.trigger.observe("user_bash_end", CTX);
		await tick();
		await tick();
		expect(calls.length).toBe(settled);
	});

	it("end() is a no-op when the factory never bound (stamps disabled)", async () => {
		const { runner } = gatedRunner();
		const bundle = createGitStampExtensionWithTrigger({ runGit: runner });
		await expect(bundle.end()).resolves.toBeUndefined();
	});
});
