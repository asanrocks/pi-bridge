// Git identity stamp writer (ADR 10). A bridge-bundled inline extension that
// records repository identity (HEAD commit, branch) as `custom` session
// entries at two boundaries: before each user message is persisted
// ("prompt") and after each turn settles ("turn_end"). Only identity
// *transitions* are written — the baseline is the last valid v1 stamp on the
// active session path (`sessionManager.getBranch()`), so resume and fork need
// no process-local state. See docs/10-adr-git-stamp.md.

import { spawn } from "node:child_process";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
	GIT_STAMP_CUSTOM_TYPE,
	type GitIdentity,
	type GitStampAnchor,
	parseGitIdentity,
	parseGitStampEntry,
	sameGitIdentity,
} from "../core/git-stamp.ts";

// ============================================================================
// Git process runner (injectable seam)
// ============================================================================

export interface GitRunOptions {
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface GitRunResult {
	/** Exit code; null when the process could not be spawned or was killed. */
	code: number | null;
	stdout: string;
	/** True when killed by timeout or abort. Always a failed observation. */
	killed: boolean;
}

export type GitRunner = (args: string[], options: GitRunOptions) => Promise<GitRunResult>;

/**
 * Spawn `git <args>` with a bounded lifetime. Exit code 1 is meaningful for
 * the plumbing commands used here (unborn HEAD / detached HEAD); spawn
 * failures and kills resolve with `code: null` so the caller can tell them
 * apart from exit 1.
 */
function spawnGit(args: string[], options: GitRunOptions): Promise<GitRunResult> {
	return new Promise((resolve) => {
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn("git", args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch {
			resolve({ code: null, stdout: "", killed: false });
			return;
		}

		let stdout = "";
		let settled = false;
		let killTimer: NodeJS.Timeout | undefined;
		let forceKillTimer: NodeJS.Timeout | undefined;
		const finish = (code: number | null, killed = false) => {
			if (settled) return;
			settled = true;
			if (killTimer) clearTimeout(killTimer);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			options.signal?.removeEventListener("abort", kill);
			resolve({ code, stdout, killed });
		};
		const kill = () => {
			// Resolve first — the budget is spent; the kills are just cleanup.
			finish(null, true);
			proc.kill("SIGTERM");
			// Bounded cleanup even if git ignores SIGTERM.
			forceKillTimer = setTimeout(() => proc.kill("SIGKILL"), 1000);
		};

		proc.on("error", () => finish(null)); // e.g. missing git binary
		proc.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		proc.on("close", (code) => finish(code));
		if (options.signal) {
			if (options.signal.aborted) kill();
			else options.signal.addEventListener("abort", kill, { once: true });
		}
		if (options.timeoutMs > 0) killTimer = setTimeout(kill, options.timeoutMs);
	});
}

// ============================================================================
// Extension
// ============================================================================

export interface GitStampDeps {
	/** Git runner. Default: spawn `git` directly (node-only). */
	runGit: GitRunner;
	/** Per-command budget in ms. Default: 500. */
	timeoutMs: number;
}

/**
 * Build the git-stamp extension factory. `deps` is a test seam: inject
 * `runGit` to fake the repository, `timeoutMs` to shorten the budget.
 */
export function createGitStampExtension(deps: Partial<GitStampDeps> = {}): ExtensionFactory {
	const runGit = deps.runGit ?? spawnGit;
	const timeoutMs = deps.timeoutMs ?? 500;

	return (pi) => {
		// Serialized observations. Each task must recover before the chain
		// continues, so one failed observation cannot block later ones.
		let queue: Promise<void> = Promise.resolve();
		const enqueue = (anchor: GitStampAnchor, ctx: ExtensionContext): Promise<void> => {
			const task = queue.then(() => observe(anchor, ctx));
			queue = task;
			return task;
		};

		const observe = async (anchor: GitStampAnchor, ctx: ExtensionContext): Promise<void> => {
			try {
				// Baseline first: the last valid v1 stamp on the active path.
				const baseline = baselineIdentity(ctx);
				const identity = await queryIdentity(ctx);
				if (identity === null) return; // observation failure — write nothing
				if (baseline && sameGitIdentity(baseline, identity)) return;
				pi.appendEntry(GIT_STAMP_CUSTOM_TYPE, {
					v: 1,
					anchor,
					commit: identity.commit,
					branch: identity.branch,
				});
			} catch {
				// Observation failure — write nothing, never poison the queue.
			}
		};

		const baselineIdentity = (ctx: ExtensionContext): GitIdentity | null => {
			const path = ctx.sessionManager.getBranch();
			for (let i = path.length - 1; i >= 0; i--) {
				const stamp = parseGitStampEntry(path[i]);
				if (stamp) return { commit: stamp.commit, branch: stamp.branch };
			}
			return null;
		};

		const queryIdentity = async (ctx: ExtensionContext): Promise<GitIdentity | null> => {
			const options: GitRunOptions = { cwd: ctx.cwd, timeoutMs };
			if (ctx.signal) options.signal = ctx.signal;
			// Exit code 1 is meaningful: unborn HEAD (rev-parse) / detached
			// HEAD (symbolic-ref). Kills, spawn failures, and other codes are
			// observation failures.
			const [head, symref] = await Promise.all([
				runGit(["rev-parse", "--verify", "--quiet", "HEAD"], options),
				runGit(["symbolic-ref", "--short", "--quiet", "HEAD"], options),
			]);
			if (head.killed || symref.killed) return null;
			if (head.code !== 0 && head.code !== 1) return null;
			if (symref.code !== 0 && symref.code !== 1) return null;
			return parseGitIdentity(
				head.code === 1 ? null : head.stdout.trim(),
				symref.code === 1 ? null : symref.stdout.trim(),
			);
		};

		// Handlers are awaited by pi. For a prompt this places the stamp (when
		// written) before the user message in the session file; for turn_end
		// the turn's entries are already persisted, so the stamp is the leaf
		// after the turn.
		pi.on("message_start", async (event, ctx) => {
			if (event.message.role !== "user") return;
			await enqueue("prompt", ctx);
		});
		pi.on("turn_end", async (_event, ctx) => {
			await enqueue("turn_end", ctx);
		});
	};
}
