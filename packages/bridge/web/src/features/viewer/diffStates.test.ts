import { describe, expect, it } from "vitest";
import type { TurnVM } from "../../../../src/viewmodel/index.ts";
import { collectDiffStates, isPinnedCommit } from "./diffStates.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(64);

function userTurn(commit: string | null, subject: string | null = null): TurnVM {
	return {
		kind: "user",
		entryId: `u-${commit ?? "none"}`,
		index: 0,
		text: "",
		images: [],
		timestamp: "2024-01-01T00:00:00.000Z",
		gitIdentity: commit === null ? undefined : { commit, branch: "main" },
		gitCommitSubject: subject,
	} as unknown as TurnVM;
}

function assistantTurn(commit: string, subject: string | null): TurnVM {
	return {
		kind: "assistant",
		entryId: "a",
		index: 1,
		blocks: [],
		turnKey: "a",
		timestamp: "2024-01-01T00:00:00.000Z",
		gitChanges: [
			{
				entryId: "s",
				timestamp: "2024-01-01T00:00:00.000Z",
				identity: { commit, branch: "main" },
				commitSubject: subject,
				anchor: "tool_end",
				isInitial: false,
				afterBlockKey: "a:b0",
			},
		],
	} as unknown as TurnVM;
}

describe("collectDiffStates", () => {
	it("collects observed commits in path order, then the floating states", () => {
		const states = collectDiffStates([userTurn(A, "first"), userTurn(B, "second")]);
		expect(states.map((s) => s.value)).toEqual([A, B, "head", "index", "worktree"]);
		expect(states[0]).toMatchObject({ label: A.slice(0, 8), subject: "first" });
		expect(states.at(-3)).toMatchObject({ value: "head", label: "HEAD" });
		expect(states.at(-2)).toMatchObject({ value: "index", label: "Index" });
		expect(states.at(-1)).toMatchObject({ value: "worktree", label: "Working tree" });
	});

	it("dedupes a commit and lets a later stamp supply the missing subject", () => {
		const states = collectDiffStates([userTurn(A, null), assistantTurn(A, "backfilled"), userTurn(A, "ignored")]);
		expect(states.map((s) => s.value)).toEqual([A, "head", "index", "worktree"]);
		expect(states[0]?.subject).toBe("backfilled");
	});

	it("keeps a 64-char object id and drops unborn or malformed commits", () => {
		const states = collectDiffStates([userTurn(null), userTurn("not-a-sha"), userTurn(C, "sha256")]);
		expect(states.map((s) => s.value)).toEqual([C, "head", "index", "worktree"]);
	});
});

describe("isPinnedCommit", () => {
	it("accepts only 40/64-char lowercase hex", () => {
		expect(isPinnedCommit(A)).toBe(true);
		expect(isPinnedCommit(C)).toBe(true);
		expect(isPinnedCommit("head")).toBe(false);
		expect(isPinnedCommit("worktree")).toBe(false);
		expect(isPinnedCommit(A.toUpperCase())).toBe(false);
		expect(isPinnedCommit("abc")).toBe(false);
	});
});
