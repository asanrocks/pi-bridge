// ============================================================================
// activityLabel — the busy row's preview line: the tool with its rebased
// elapsed time, or the phase word when no tool is running.
// ============================================================================

import { describe, expect, it } from "vitest";
import { activityLabel } from "./activityLabel.ts";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");

describe("activityLabel", () => {
	it("names the tool with the phase's elapsed time, rebased onto the reader's clock", () => {
		expect(activityLabel({ kind: "tool", name: "Bash", startedAt: "2026-01-01T11:45:00.000Z" }, NOW)).toBe(
			"Bash · 15m",
		);
	});

	it("falls back to the bare name when the start instant is unusable", () => {
		expect(activityLabel({ kind: "tool", name: "Bash", startedAt: "not a date" }, NOW)).toBe("Bash");
	});

	it("states the phase when no tool is running", () => {
		expect(activityLabel({ kind: "responding" }, NOW)).toBe("Responding…");
		expect(activityLabel({ kind: "compacting" }, NOW)).toBe("Compacting…");
	});

	it("renders nothing for a row with no activity, so no second line appears", () => {
		expect(activityLabel(undefined, NOW)).toBe("");
	});

	it("drops a clock-skewed future start's duration but keeps the tool name", () => {
		// A negative elapsed is not a duration: `formatSpan` refuses it, so the
		// label states what is running instead of inventing a time.
		expect(activityLabel({ kind: "tool", name: "Read", startedAt: "2026-01-01T12:00:30.000Z" }, NOW)).toBe("Read");
	});
});
