// ============================================================================
// diffStates — the review surface's addressable states, projected from the
// git-stamp timeline the ViewModel already folds. The FileBrowser header's
// pickers offer these, so switching an endpoint (e.g. a recorded commit →
// the working tree) never needs a new git query: every commit in the list was
// observed by a stamp on the active path.
//
// Pure and store-free (unit-tested): the caller passes `vm.turns`.
// ============================================================================

import type { TurnVM } from "../../../../src/viewmodel/index.ts";

/** One selectable endpoint of a review diff. */
export interface DiffStateOption {
	/** A pinned oid, or the literal "head" / "worktree". */
	value: string;
	/** Short display label (an abbreviated oid, or "HEAD" / "Working tree"). */
	label: string;
	/** Commit subject when the timeline knows it. */
	subject: string | null;
}

const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** True for a pinned commit oid (as opposed to "head" / "worktree"). */
export function isPinnedCommit(state: string): boolean {
	return COMMIT_RE.test(state);
}

/**
 * Every commit the timeline observed, in path order, with the subjects the
 * stamps carry; then the floating states: HEAD, the index, the working tree.
 * "worktree" is a valid `new` end but not a valid `old` end (the host
 * rejects it), so callers filter it out of the base picker.
 */
export function collectDiffStates(turns: readonly TurnVM[]): DiffStateOption[] {
	const subjects = new Map<string, string | null>();
	const add = (commit: string | null | undefined, subject: string | null | undefined) => {
		if (commit === null || commit === undefined || !COMMIT_RE.test(commit)) return;
		// First observation wins the position; a later stamp may still supply
		// the subject a v1 stamp lacked.
		if (!subjects.has(commit)) subjects.set(commit, subject ?? null);
		else if (subjects.get(commit) === null && subject) subjects.set(commit, subject);
	};

	for (const turn of turns) {
		if (turn.kind === "user") {
			add(turn.gitIdentity?.commit, turn.gitCommitSubject);
		} else if (turn.kind === "gitChange") {
			add(turn.identity.commit, turn.commitSubject);
		} else if (turn.kind === "assistant" && turn.gitChanges) {
			for (const stamp of turn.gitChanges) add(stamp.identity.commit, stamp.commitSubject);
		}
	}

	const options: DiffStateOption[] = [...subjects].map(([value, subject]) => ({
		value,
		label: value.slice(0, 8),
		subject,
	}));
	options.push({ value: "head", label: "HEAD", subject: null });
	options.push({ value: "index", label: "Index", subject: null });
	options.push({ value: "worktree", label: "Working tree", subject: null });
	return options;
}
