import { describe, expect, it } from "vitest";
import {
	GIT_STAMP_CUSTOM_TYPE,
	isValidBranchName,
	isValidCommitId,
	parseCommitSubject,
	parseGitIdentity,
	parseGitStampData,
	parseGitStampEntry,
	sameGitIdentity,
} from "../../src/core/git-stamp.ts";

const SHA1 = "0123456789abcdef0123456789abcdef01234567";
const SHA1_B = "fedcba9876543210fedcba9876543210fedcba98";
const SHA256 = "a".repeat(64);

function stamp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { v: 1, anchor: "prompt", commit: SHA1, branch: "main", ...overrides };
}

function stampV2(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { v: 2, anchor: "tool_end", commit: SHA1, branch: "main", commitSubject: "a subject", ...overrides };
}

describe("isValidCommitId", () => {
	it("accepts 40-char and 64-char lowercase hex", () => {
		expect(isValidCommitId(SHA1)).toBe(true);
		expect(isValidCommitId(SHA256)).toBe(true);
	});

	it("rejects uppercase, wrong length, and non-hex", () => {
		expect(isValidCommitId(SHA1.toUpperCase())).toBe(false);
		expect(isValidCommitId(SHA1.slice(1))).toBe(false);
		expect(isValidCommitId(`g${SHA1.slice(1)}`)).toBe(false);
		expect(isValidCommitId("")).toBe(false);
		expect(isValidCommitId(`${SHA1}\n`)).toBe(false);
	});
});

describe("isValidBranchName", () => {
	it("accepts ordinary names", () => {
		expect(isValidBranchName("main")).toBe(true);
		expect(isValidBranchName("feature/x-2_fix")).toBe(true);
		expect(isValidBranchName("a/b/c/d")).toBe(true);
	});

	it("rejects empty, embedded newlines, and control characters", () => {
		expect(isValidBranchName("")).toBe(false);
		expect(isValidBranchName("main\nmain")).toBe(false);
		expect(isValidBranchName("main\tmain")).toBe(false);
		expect(isValidBranchName("main\u0007")).toBe(false);
		expect(isValidBranchName("main\u007f")).toBe(false);
	});
});

describe("parseGitIdentity", () => {
	it("parses full identity", () => {
		expect(parseGitIdentity(SHA1, "main")).toEqual({ commit: SHA1, branch: "main" });
	});

	it("allows null commit (unborn HEAD) and null branch (detached)", () => {
		expect(parseGitIdentity(null, "main")).toEqual({ commit: null, branch: "main" });
		expect(parseGitIdentity(SHA1, null)).toEqual({ commit: SHA1, branch: null });
		expect(parseGitIdentity(null, null)).toEqual({ commit: null, branch: null });
	});

	it("rejects invalid raw output", () => {
		expect(parseGitIdentity("not-a-hash", "main")).toBeNull();
		expect(parseGitIdentity(SHA1, "a\nb")).toBeNull();
		expect(parseGitIdentity(SHA1, "")).toBeNull();
	});
});

describe("parseGitStampData", () => {
	it("accepts a well-formed v1 stamp", () => {
		expect(parseGitStampData(stamp())).toEqual({
			v: 1,
			anchor: "prompt",
			commit: SHA1,
			branch: "main",
		});
		expect(parseGitStampData(stamp({ anchor: "turn_end" }))).toMatchObject({ anchor: "turn_end" });
	});

	it("accepts a well-formed v2 stamp with any v2 anchor", () => {
		for (const anchor of ["prompt", "tool_end", "turn_end", "user_bash_end"]) {
			expect(parseGitStampData(stampV2({ anchor }))).toEqual({
				v: 2,
				anchor,
				commit: SHA1,
				branch: "main",
				commitSubject: "a subject",
			});
		}
	});

	it("accepts null commitSubject and a missing commitSubject field", () => {
		expect(parseGitStampData(stampV2({ commitSubject: null }))).toMatchObject({ commitSubject: null });
		const { commitSubject: _omit, ...without } = stampV2() as Record<string, unknown>;
		expect(parseGitStampData(without)).toMatchObject({ commitSubject: null });
	});

	it("clears an invalid commitSubject but keeps the stamp (subject is best-effort)", () => {
		expect(parseGitStampData(stampV2({ commitSubject: 42 }))).toMatchObject({ commitSubject: null });
		expect(parseGitStampData(stampV2({ commitSubject: "two\nlines" }))).toMatchObject({ commitSubject: null });
		expect(parseGitStampData(stampV2({ commitSubject: "" }))).toMatchObject({ commitSubject: null });
	});

	it("accepts null commit and null branch combinations", () => {
		expect(parseGitStampData(stamp({ commit: null }))).toMatchObject({ commit: null });
		expect(parseGitStampData(stamp({ branch: null }))).toMatchObject({ branch: null });
		expect(parseGitStampData(stamp({ commit: null, branch: null }))).toMatchObject({
			commit: null,
			branch: null,
		});
	});

	it("rejects non-objects and arrays", () => {
		expect(parseGitStampData(null)).toBeNull();
		expect(parseGitStampData(undefined)).toBeNull();
		expect(parseGitStampData("nope")).toBeNull();
		expect(parseGitStampData(42)).toBeNull();
		expect(parseGitStampData([stamp()])).toBeNull();
	});

	it("rejects unknown versions and anchors", () => {
		expect(parseGitStampData(stamp({ v: 3 }))).toBeNull();
		expect(parseGitStampData(stamp({ v: "1" }))).toBeNull();
		expect(parseGitStampData(stamp({ anchor: "session_start" }))).toBeNull();
		// v1 predates the tool/user-bash boundaries — those anchors are v2-only.
		expect(parseGitStampData(stamp({ anchor: "tool_end" }))).toBeNull();
		// v2 without an anchor is malformed.
		const { anchor: _omit, ...noAnchor } = stampV2() as Record<string, unknown>;
		expect(parseGitStampData(noAnchor)).toBeNull();
		expect(parseGitStampData(stampV2({ anchor: "session_start" }))).toBeNull();
		expect(parseGitStampData({ ...stamp(), extra: "field" })).toEqual({
			v: 1,
			anchor: "prompt",
			commit: SHA1,
			branch: "main",
		});
	});

	it("rejects mistyped and invalid commit/branch values", () => {
		expect(parseGitStampData(stamp({ commit: 123 }))).toBeNull();
		expect(parseGitStampData(stamp({ branch: true }))).toBeNull();
		expect(parseGitStampData(stamp({ commit: "abc" }))).toBeNull();
		expect(parseGitStampData(stamp({ branch: "a\nb" }))).toBeNull();
	});
});

describe("parseGitStampEntry", () => {
	it("extracts a stamp from a pi custom entry (type discriminator)", () => {
		expect(parseGitStampEntry({ type: "custom", customType: GIT_STAMP_CUSTOM_TYPE, data: stamp() })).toMatchObject({
			v: 1,
			commit: SHA1,
			branch: "main",
		});
	});

	it("extracts a stamp from a bridge custom entry (kind discriminator)", () => {
		expect(parseGitStampEntry({ kind: "custom", customType: GIT_STAMP_CUSTOM_TYPE, data: stamp() })).toMatchObject({
			v: 1,
		});
	});

	it("returns null for other kinds, custom types, and malformed data", () => {
		expect(parseGitStampEntry({ type: "message" })).toBeNull();
		expect(parseGitStampEntry({ kind: "message" })).toBeNull();
		expect(parseGitStampEntry({ type: "custom", customType: "other.ext", data: stamp() })).toBeNull();
		expect(parseGitStampEntry({ type: "custom", customType: GIT_STAMP_CUSTOM_TYPE, data: 3 })).toBeNull();
		expect(parseGitStampEntry({ type: "custom", customType: GIT_STAMP_CUSTOM_TYPE })).toBeNull();
	});
});

describe("sameGitIdentity", () => {
	it("compares the identity key", () => {
		expect(sameGitIdentity({ commit: SHA1, branch: "main" }, { commit: SHA1, branch: "main" })).toBe(true);
		expect(sameGitIdentity({ commit: SHA1, branch: "main" }, { commit: SHA1_B, branch: "main" })).toBe(false);
		expect(sameGitIdentity({ commit: SHA1, branch: "main" }, { commit: SHA1, branch: "dev" })).toBe(false);
		expect(sameGitIdentity({ commit: null, branch: null }, { commit: null, branch: null })).toBe(true);
	});
});

describe("parseCommitSubject", () => {
	it("accepts a single-line subject", () => {
		expect(parseCommitSubject("fix: handle empty input")).toBe("fix: handle empty input");
		expect(parseCommitSubject("a".repeat(200))).toBe("a".repeat(200));
	});

	it("rejects empty, multi-line, and control-character subjects", () => {
		expect(parseCommitSubject("")).toBeNull();
		expect(parseCommitSubject("two\nlines")).toBeNull();
		expect(parseCommitSubject("trailing\r")).toBeNull();
		expect(parseCommitSubject("bell\u0007")).toBeNull();
	});
});
