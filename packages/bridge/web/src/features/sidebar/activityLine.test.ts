// activityLine — the running row's second line as data: the tool and its phase
// clock (rendered as the chip), and the agent's own words, plus the flat form
// the hover title needs.

import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../../../../src/core/index.ts";
import { activityLine, activityLineTitle } from "./activityLine.ts";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");

function row(
	activity: SessionInfo["activity"],
	lastAgentText?: string,
): Pick<SessionInfo, "activity" | "lastAgentText"> {
	return lastAgentText === undefined ? { activity } : { activity, lastAgentText };
}

describe("activityLine", () => {
	it("carries the tool with its phase clock in front of what the agent is saying", () => {
		expect(
			activityLine(
				row({ kind: "tool", name: "bash", startedAt: "2026-01-01T11:59:55.000Z" }, "Now the sessionTime test:"),
				NOW,
			),
		).toEqual({ tool: { name: "bash", elapsed: "5s" }, text: "Now the sessionTime test:" });
	});

	it("carries the tool alone while it has not said anything yet", () => {
		expect(activityLine(row({ kind: "tool", name: "bash", startedAt: "2026-01-01T11:45:00.000Z" }), NOW)).toEqual({
			tool: { name: "bash", elapsed: "15m" },
			text: "",
		});
	});

	it("drops a clock-skewed future start's duration but keeps the tool name", () => {
		// A negative elapsed is not a duration: `formatSpan` refuses it, so the
		// chip states what is running instead of inventing a time.
		expect(activityLine(row({ kind: "tool", name: "read", startedAt: "2026-01-01T12:00:30.000Z" }), NOW)).toEqual({
			tool: { name: "read" },
			text: "",
		});
		expect(activityLine(row({ kind: "tool", name: "read", startedAt: "not a date" }), NOW)).toEqual({
			tool: { name: "read" },
			text: "",
		});
	});

	it("says what the agent is saying when no tool is running", () => {
		expect(activityLine(row({ kind: "responding" }, "Now the sessionTime test:"), NOW)).toEqual({
			text: "Now the sessionTime test:",
		});
	});

	it("keeps a phase word only when there are no agent words to show", () => {
		expect(activityLine(row({ kind: "responding" }), NOW)).toEqual({ text: "Responding…" });
		// A compaction is not the agent speaking: the last words would be stale.
		expect(activityLine(row({ kind: "compacting" }, "some earlier reply"), NOW)).toEqual({ text: "Compacting…" });
	});

	it("has no line at all for a row with nothing executing", () => {
		expect(activityLine({ activity: undefined }, NOW)).toBeNull();
	});
});

describe("activityLineTitle", () => {
	it("states the whole line for a row too narrow to show it", () => {
		expect(activityLineTitle({ tool: { name: "bash", elapsed: "5s" }, text: "Now the sessionTime test:" })).toBe(
			"bash · 5s — Now the sessionTime test:",
		);
	});

	it("omits the parts that are absent", () => {
		expect(activityLineTitle({ tool: { name: "bash", elapsed: "5s" }, text: "" })).toBe("bash · 5s");
		expect(activityLineTitle({ tool: { name: "read" }, text: "" })).toBe("read");
		expect(activityLineTitle({ text: "Compacting…" })).toBe("Compacting…");
	});
});
