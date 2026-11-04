// turnDetails — the ledger's content rules: one subject per row, a label on
// every value, `~` for estimates, and absent data rendered as absent. Tested as
// data rather than through a render, because these are the rules that keep being
// re-litigated.

import { describe, expect, test } from "vitest";
import { assistantTurnDetails, userTurnDetails } from "./turnDetails.ts";

function labels(sections: ReturnType<typeof userTurnDetails>): string[] {
	return sections.flatMap((section) => section.rows.map((row) => row.label));
}

function valueFor(sections: ReturnType<typeof userTurnDetails>, label: string): string | undefined {
	for (const section of sections) for (const row of section.rows) if (row.label === label) return row.value;
	return undefined;
}

const AT = new Date(2026, 10, 4, 20, 54).toISOString();

describe("userTurnDetails", () => {
	test("the repository state is three subjects, not one composed string", () => {
		const sections = userTurnDetails({
			timestamp: AT,
			thoughtForMs: 42000,
			gitIdentity: { branch: "dev-bridge", commit: "8d345a29aaaaaaaa" },
			gitCommitSubject: "reorder pinned models with a whole-list replace",
		});
		expect(labels(sections)).toEqual(["Time", "Since last reply", "Branch", "Commit", "Subject"]);
		expect(valueFor(sections, "Commit")).toBe("8d345a29");
		expect(valueFor(sections, "Subject")).toBe("reorder pinned models with a whole-list replace");
	});

	test("each repository row hides on its own", () => {
		const detached = userTurnDetails({
			timestamp: AT,
			gitIdentity: { branch: null, commit: "8d345a29" },
			gitCommitSubject: null,
		});
		expect(labels(detached)).toEqual(["Time", "Commit"]);

		const unborn = userTurnDetails({
			timestamp: AT,
			gitIdentity: { branch: "main", commit: null },
			gitCommitSubject: null,
		});
		expect(labels(unborn)).toEqual(["Time", "Branch"]);
	});

	test("the reply gap is a duration label, and a sub-second gap has no row", () => {
		const instant = userTurnDetails({ timestamp: AT, thoughtForMs: 800 });
		expect(labels(instant)).toEqual(["Time"]);

		const slow = userTurnDetails({ timestamp: AT, thoughtForMs: 42000 });
		expect(valueFor(slow, "Since last reply")).toBe("~42s");

		// No prior completion (the first turn) — the same rule, different cause.
		expect(labels(userTurnDetails({ timestamp: AT }))).toEqual(["Time"]);
	});

	test("a turn with no repository evidence has one section, so no divider", () => {
		expect(userTurnDetails({ timestamp: AT, thoughtForMs: 42000 })).toHaveLength(1);
	});
});

describe("assistantTurnDetails", () => {
	test("three sections in producer, context, timing order", () => {
		const sections = assistantTurnDetails({
			timestamp: AT,
			modelName: "DeepSeek V4.1 Flash",
			providerName: "Volcengine Gateway",
			totalMs: 79000,
			toolMs: 55000,
			contextPercent: 15.4,
			contextDeltaPercent: 11.2,
		});
		expect(sections.map((s) => s.rows.map((r) => r.label))).toEqual([
			["Model", "Provider"],
			["Context"],
			["Time", "Duration", "Tools"],
		]);
		expect(valueFor(sections, "Context")).toBe("15% (+11%)");
		expect(valueFor(sections, "Duration")).toBe("~1m 19s");
	});

	test("a tool-free turn has no Tools row instead of a confident <1s", () => {
		const sections = assistantTurnDetails({ timestamp: AT, totalMs: 4000, toolMs: 0 });
		expect(labels(sections)).not.toContain("Tools");
	});

	test("an unavailable context reading drops its section entirely", () => {
		// Aborted and errored stops carry no trustworthy usage, so the percentage
		// — and its section — are absent rather than zeroed.
		const sections = assistantTurnDetails({ timestamp: AT, totalMs: 4000 });
		expect(sections.map((s) => s.rows.map((r) => r.label))).toEqual([["Time", "Duration"]]);
	});

	test("the unsealed turn names its start anchor, like the header does", () => {
		const sections = assistantTurnDetails({ timestamp: "", turnStartedAt: AT });
		expect(valueFor(sections, "Time")).toContain("2026");
	});

	test("a context change below the display threshold is not rendered", () => {
		const sections = assistantTurnDetails({
			timestamp: AT,
			contextPercent: 15.4,
			contextDeltaPercent: undefined,
		});
		expect(valueFor(sections, "Context")).toBe("15%");
	});
});
