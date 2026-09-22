// ============================================================================
// browserHeading — the repository browser's semantic header (ADR 14 follow-up).
//
// The browser's internal target is a pair (`baseline -> state`), but the header
// names the user's task instead of exposing both endpoints as permanent
// selectors. Four surfaces fall out of the pair:
//
//   • files      — no baseline; one state read in a full tree.
//   • working    — a worktree content state; the uncommitted delta.
//   • commit     — a pinned commit against its base (a commit review).
//   • transition — two recorded states (a git-stamp window).
//
// Pure and store-free (unit-tested): the caller passes the target's primitive
// fields and the timeline's states.
// ============================================================================

import { type DiffStateOption, isPinnedCommit } from "./diffStates.ts";

/** Which of the four semantic surfaces the header is showing. */
export type BrowserSurface = "files" | "working" | "commit" | "transition";

export interface BrowserHeading {
	surface: BrowserSurface;
	/** Headline: "Files", "Working changes", a commit, or the window's label. */
	title: string;
	/**
	 * Comparison phrase appended to the changed-file count, e.g. `since HEAD`
	 * or `a1b2c3d → d4e5f6a`. Empty for `files`, whose detail line is the root.
	 */
	comparison: string;
}

/** How the pair was chosen: a commit review (baseline = the commit's base)
 * versus a recorded transition window. A commit-to-commit transition and a
 * commit review share a pinned-commit `state`, so the surface cannot be
 * inferred from the pair alone. */
export type BrowserOrigin = "commit" | "transition";

/** The display name of one endpoint, preferring the timeline's label. */
function stateName(value: string, states: readonly DiffStateOption[]): string {
	return states.find((s) => s.value === value)?.label ?? value.slice(0, 8);
}

/** First non-empty line of a label, so a multi-line turn text stays a headline. */
function firstLine(text: string): string {
	return text.split("\n")[0]?.trim() ?? "";
}

/**
 * Derive the header from the target's pair and the optional origin label.
 * `label` names the transition's origin (a turn's first line, or a commit
 * subject); it is ignored by the `working` and `files` surfaces, which name
 * themselves, and by `commit`, which prefers the commit's own subject.
 */
export function browserHeading(
	target: { state: string; baseline?: string; label?: string; origin?: BrowserOrigin },
	states: readonly DiffStateOption[],
): BrowserHeading {
	const { state, baseline, label, origin } = target;
	if (baseline === undefined) {
		return { surface: "files", title: "Files", comparison: "" };
	}
	if (state === "worktree") {
		return {
			surface: "working",
			title: "Working changes",
			comparison: `since ${stateName(baseline, states)}`,
		};
	}
	if (origin !== "transition" && isPinnedCommit(state)) {
		const subject = states.find((s) => s.value === state)?.subject ?? null;
		const short = state.slice(0, 8);
		return {
			surface: "commit",
			title: subject ? `${short} · ${subject}` : short,
			comparison: `compared with ${stateName(baseline, states)}`,
		};
	}
	const pair = `${stateName(baseline, states)} → ${stateName(state, states)}`;
	const trimmed = label === undefined ? "" : firstLine(label);
	return { surface: "transition", title: trimmed || pair, comparison: pair };
}
