// repositoryMenuRows — the menu keeps its browse row in every git state.
// The regression it pins: the count used to gate the whole control, so a clean
// worktree, a non-git Project, and an unreadable one had no entry at all.

import { describe, expect, test } from "vitest";
import { type RepositoryMenuDirt, repositoryMenuRows } from "./repositoryMenuRows.ts";

function labels(dirt: RepositoryMenuDirt | null): string[] {
	return repositoryMenuRows(dirt).map((row) => row.label);
}

describe("repositoryMenuRows — browse is not a git state", () => {
	test("a clean worktree offers browse alone", () => {
		expect(labels({ count: 0, omitted: 0 })).toEqual(["Browse files"]);
	});

	test("an unreadable or non-git Project offers browse alone", () => {
		expect(labels(null)).toEqual(["Browse files"]);
	});

	test("dirt puts the review first, with its count and the omitted note", () => {
		const rows = repositoryMenuRows({ count: 3, omitted: 2 });
		expect(rows.map((row) => row.key)).toEqual(["review", "browse"]);
		expect(rows[0]?.label).toBe("Review 3 uncommitted files");
		expect(rows[0]?.detail).toBe("HEAD → working tree (+2 omitted)");
	});

	test("one file reads singular, and a clean omission note stays short", () => {
		const rows = repositoryMenuRows({ count: 1, omitted: 0 });
		expect(rows[0]?.label).toBe("Review 1 uncommitted file");
		expect(rows[0]?.detail).toBe("HEAD → working tree");
	});
});
