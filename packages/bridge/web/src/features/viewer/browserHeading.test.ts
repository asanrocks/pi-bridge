// browserHeading — the browser header's semantic surface and title derivation.
// Pure functions, hand-built inputs.

import { describe, expect, it } from "vitest";
import { browserHeading } from "./browserHeading.ts";
import type { DiffStateOption } from "./diffStates.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

const states: DiffStateOption[] = [
	{ value: A, label: A.slice(0, 8), subject: "Implement parser" },
	{ value: B, label: B.slice(0, 8), subject: null },
	{ value: "head", label: "HEAD", subject: null },
	{ value: "index", label: "Index", subject: null },
	{ value: "worktree", label: "Working tree", subject: null },
];

describe("browserHeading", () => {
	it("names the single-state read Files", () => {
		expect(browserHeading({ state: "worktree" }, states)).toEqual({
			surface: "files",
			title: "Files",
			comparison: "",
		});
	});

	it("names the uncommitted delta Working changes", () => {
		expect(browserHeading({ state: "worktree", baseline: "head" }, states)).toEqual({
			surface: "working",
			title: "Working changes",
			comparison: "since HEAD",
		});
	});

	it("describes an unstaged delta as since Index", () => {
		expect(browserHeading({ state: "worktree", baseline: "index" }, states).comparison).toBe("since Index");
	});

	it("names a worktree read since a commit Working changes, not a transition", () => {
		expect(browserHeading({ state: "worktree", baseline: A, origin: "transition" }, states)).toEqual({
			surface: "working",
			title: "Working changes",
			comparison: `since ${A.slice(0, 8)}`,
		});
	});

	it("leads a commit review with the short oid and subject", () => {
		expect(browserHeading({ state: A, baseline: "head", origin: "commit" }, states)).toEqual({
			surface: "commit",
			title: `${A.slice(0, 8)} · Implement parser`,
			comparison: "compared with HEAD",
		});
	});

	it("treats a pinned state with no origin as a commit review", () => {
		expect(browserHeading({ state: A, baseline: "head" }, states).surface).toBe("commit");
	});

	it("falls back to the short oid when the commit has no subject", () => {
		expect(browserHeading({ state: B, baseline: A, origin: "commit" }, states).title).toBe(B.slice(0, 8));
	});

	it("labels a transition with its origin label", () => {
		expect(browserHeading({ state: B, baseline: A, label: "Fix the tests", origin: "transition" }, states)).toEqual({
			surface: "transition",
			title: "Fix the tests",
			comparison: `${A.slice(0, 8)} → ${B.slice(0, 8)}`,
		});
	});

	it("prefers the transition surface over the commit surface when origin says so", () => {
		// A commit-to-commit window shares a pinned state with a commit review;
		// only the origin can tell them apart.
		expect(browserHeading({ state: B, baseline: A, origin: "transition" }, states).surface).toBe("transition");
	});

	it("falls back to the pair when the transition has no label", () => {
		expect(browserHeading({ state: B, baseline: A, origin: "transition" }, states).title).toBe(
			`${A.slice(0, 8)} → ${B.slice(0, 8)}`,
		);
	});

	it("keeps only the first line of a multi-line label", () => {
		expect(
			browserHeading({ state: B, baseline: A, label: "Add parser\n\nwith tests", origin: "transition" }, states)
				.title,
		).toBe("Add parser");
	});

	it("treats a staged review as a transition", () => {
		expect(browserHeading({ state: "index", baseline: "head" }, states)).toEqual({
			surface: "transition",
			title: "HEAD → Index",
			comparison: "HEAD → Index",
		});
	});
});
