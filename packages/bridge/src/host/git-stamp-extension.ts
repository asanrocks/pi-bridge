// Git identity stamp writer (ADR 10). A bridge-bundled inline extension that
// records repository identity (HEAD commit, branch, subject) as `custom`
// session entries at operation boundaries: before each user message is
// persisted ("prompt"), after each agent tool finishes ("tool_end"), after
// each turn settles ("turn_end", backstop), and after a user `!` command's
// entry is persisted ("user_bash_end", host-triggered). Only identity
// *transitions* are written — the baseline is the last valid stamp on the
// active session path (`sessionManager.getBranch()`), so resume and fork need
// no process-local state. See docs/10-adr-git-stamp.md.

import { spawn } from "node:child_process";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
	GIT_STAMP_CUSTOM_TYPE,
	type GitIdentity,
	type GitStampAnchor,
	parseCommitSubject,
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

/** The context slice an observation needs. Structurally satisfied by
 * pi's ExtensionContext, and by the host Manager for user-bash triggers. */
export interface GitStampObserveContext {
	cwd: string;
	sessionManager: { getBranch(): unknown[] };
	signal?: AbortSignal;
}

/** Host-side handle for queueing observations outside extension events
 * (ADR 10 v2: the user_bash_end boundary is observed by the host, which sees
 * the persisted `bashExecution` entry via `entry_appended`). */
export interface GitStampTrigger {
	/** Queue an observation into the extension's serialized stream.
	 * Fire-and-forget: the stamp lands when the queued git queries finish,
	 * normally parented to the current leaf (the bash entry). */
	observe(anchor: "user_bash_end", ctx: GitStampObserveContext): void;
}

/** Factory + host-trigger pair. The trigger targets whichever session the
 * factory last bound to — each bind (initial and every rebind) creates a new
 * serialized queue, and the trigger is repointed at it. */
export interface GitStampExtensionBundle {
	factory: ExtensionFactory;
	trigger: GitStampTrigger;
}

function removeOneLineEnding(raw: string): string {
	if (!raw.endsWith("\n")) return raw;
	const withoutLf = raw.slice(0, -1);
	return withoutLf.endsWith("\r") ? withoutLf.slice(0, -1) : withoutLf;
}

/**
 * Spawn `git <args>` with a bounded lifetime. Exit code 1 is meaningful for
 * the plumbing commands used here (unborn HEAD / detached HEAD); spawn
 * failures and kills resolve with `code: null` so the caller can tell them
 * apart from exit 1.
 */
export function spawnGit(args: string[], options: GitRunOptions): Promise<GitRunResult> {
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
		const clearKillState = () => {
			if (killTimer) clearTimeout(killTimer);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			killTimer = undefined;
			forceKillTimer = undefined;
			options.signal?.removeEventListener("abort", kill);
		};
		const finish = (code: number | null, killed = false) => {
			if (settled) return;
			settled = true;
			clearKillState();
			resolve({ code, stdout, killed });
		};
		const kill = () => {
			if (settled) return;
			settled = true;
			if (killTimer) clearTimeout(killTimer);
			killTimer = undefined;
			options.signal?.removeEventListener("abort", kill);
			// Resolve first — the budget is spent; the kills are just cleanup.
			resolve({ code: null, stdout, killed: true });
			proc.kill("SIGTERM");
			// Bounded cleanup even if git ignores SIGTERM. The normal close event
			// clears this timer when the child exits after SIGTERM.
			forceKillTimer = setTimeout(() => {
				forceKillTimer = undefined;
				proc.kill("SIGKILL");
			}, 1000);
		};

		proc.on("error", () => finish(null)); // e.g. missing git binary
		proc.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		proc.on("close", (code) => {
			if (settled) clearKillState();
			else finish(code);
		});
		if (options.signal) {
			if (options.signal.aborted) kill();
			else options.signal.addEventListener("abort", kill, { once: true });
		}
		if (!settled && options.timeoutMs > 0) killTimer = setTimeout(kill, options.timeoutMs);
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
	return createGitStampExtensionWithTrigger(deps).factory;
}

/**
 * Build the git-stamp extension factory plus the host-side trigger handle
 * (user_bash_end observations). The manager keeps the trigger; the factory
 * goes to `resourceLoaderOptions.extensionFactories`.
 */
export function createGitStampExtensionWithTrigger(deps: Partial<GitStampDeps> = {}): GitStampExtensionBundle {
	const runGit = deps.runGit ?? spawnGit;
	const timeoutMs = deps.timeoutMs ?? 500;

	// Set by each factory invocation (initial bind and every session rebind).
	let boundEnqueue: ((anchor: GitStampAnchor, ctx: GitStampObserveContext) => Promise<void>) | null = null;
	const trigger: GitStampTrigger = {
		observe(anchor, ctx) {
			// Before the first bind there is no session to observe; observe()
			// never rejects (it recovers), the catch is belt-and-braces.
			boundEnqueue?.(anchor, ctx).catch(() => {});
		},
	};

	const factory: ExtensionFactory = (pi) => {
		// Serialized observations. Each task must recover before the chain
		// continues, so one failed observation cannot block later ones.
		let queue: Promise<void> = Promise.resolve();
		const enqueue = (anchor: GitStampAnchor, ctx: GitStampObserveContext): Promise<void> => {
			const task = queue.then(() => observe(anchor, ctx));
			queue = task;
			return task;
		};
		boundEnqueue = enqueue;

		const observe = async (anchor: GitStampAnchor, ctx: GitStampObserveContext): Promise<void> => {
			try {
				// Baseline first: the last valid stamp on the active path.
				const baseline = baselineIdentity(ctx);
				const observed = await queryIdentity(ctx);
				if (observed === null) return; // observation failure — write nothing
				if (baseline && sameGitIdentity(baseline, observed.identity)) return;
				pi.appendEntry(GIT_STAMP_CUSTOM_TYPE, {
					v: 2,
					anchor,
					commit: observed.identity.commit,
					branch: observed.identity.branch,
					commitSubject: observed.commitSubject,
				});
			} catch {
				// Observation failure — write nothing, never poison the queue.
			}
		};

		const baselineIdentity = (ctx: GitStampObserveContext): GitIdentity | null => {
			const path = ctx.sessionManager.getBranch();
			for (let i = path.length - 1; i >= 0; i--) {
				const stamp = parseGitStampEntry(path[i] as Parameters<typeof parseGitStampEntry>[0]);
				if (stamp) return { commit: stamp.commit, branch: stamp.branch };
			}
			return null;
		};

		const queryIdentity = async (
			ctx: GitStampObserveContext,
		): Promise<{ identity: GitIdentity; commitSubject: string | null } | null> => {
			const options: GitRunOptions = { cwd: ctx.cwd, timeoutMs };
			if (ctx.signal) options.signal = ctx.signal;
			// Exit code 1 is meaningful: unborn HEAD (rev-parse) / detached
			// HEAD (symbolic-ref). Kills, spawn failures, and other codes are
			// observation failures. The subject query runs alongside — it is
			// best-effort and only used when HEAD resolves.
			const [head, symref, subject] = await Promise.all([
				runGit(["rev-parse", "--verify", "--quiet", "HEAD"], options),
				runGit(["symbolic-ref", "--short", "--quiet", "HEAD"], options),
				runGit(["log", "-1", "--format=%s", "--no-decorate", "HEAD"], options),
			]);
			if (head.killed || symref.killed) return null;
			if (head.code !== 0 && head.code !== 1) return null;
			if (symref.code !== 0 && symref.code !== 1) return null;
			const identity = parseGitIdentity(
				head.code === 1 ? null : removeOneLineEnding(head.stdout),
				symref.code === 1 ? null : removeOneLineEnding(symref.stdout),
			);
			if (identity === null) return null;
			// Subject: only meaningful when HEAD resolves; any failure (kill,
			// nonzero exit, malformed output) clears it — identity stays valid.
			const commitSubject =
				identity.commit !== null && subject.code === 0 && !subject.killed
					? parseCommitSubject(removeOneLineEnding(subject.stdout))
					: null;
			return { identity, commitSubject };
		};

		// Handlers are awaited by pi. For a prompt this places the stamp (when
		// written) before the user message in the session file. A tool-end
		// stamp lands after the assistant tool-call entry and before the
		// tool-result message is persisted. For turn_end the turn's entries are
		// already persisted, so the stamp is the leaf after the turn.
		pi.on("message_start", async (event, ctx) => {
			if (event.message.role !== "user") return;
			await enqueue("prompt", ctx);
		});
		pi.on("tool_execution_end", async (_event, ctx) => {
			await enqueue("tool_end", ctx);
		});
		pi.on("turn_end", async (_event, ctx) => {
			await enqueue("turn_end", ctx);
		});
	};

	return { factory, trigger };
}
