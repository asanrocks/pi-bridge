// format — the turn header's span fragment. The estimate itself comes from the
// viewmodel; this pins how it is worded, including the two thresholds (the tool
// share only once it passes a second, the live branch only while streaming).

import { describe, expect, test } from "vitest";
import { formatTurnSpan } from "./format.ts";

const NOW = new Date(2026, 10, 3, 14, 5).getTime();

function span(input: Partial<Parameters<typeof formatTurnSpan>[0]>): string {
	return formatTurnSpan({
		isStreaming: false,
		turnStartedAt: new Date(NOW - 12000).toISOString(),
		totalMs: 12000,
		toolMs: 0,
		runningTools: 0,
		now: NOW,
		...input,
	});
}

describe("formatTurnSpan — sealed turn", () => {
	test("names the span alone when nothing ran in tools", () => {
		expect(span({})).toBe("worked for 12s");
	});

	test("adds the tool share once it passes a second", () => {
		expect(span({ toolMs: 4000 })).toBe("worked for 12s · tools 4s");
		expect(span({ toolMs: 999 })).toBe("worked for 12s");
	});

	test("writes nothing when the turn has not sealed", () => {
		expect(span({ totalMs: undefined })).toBe("");
		expect(span({ totalMs: undefined, toolMs: undefined })).toBe("");
	});
});

describe("formatTurnSpan — streaming turn", () => {
	test("ticks a live span from the turn anchor", () => {
		expect(span({ isStreaming: true, totalMs: undefined, toolMs: undefined })).toBe("working for 12s");
	});

	test("counts the running tools beside it", () => {
		expect(span({ isStreaming: true, totalMs: undefined, toolMs: undefined, runningTools: 2 })).toBe(
			"working for 12s · 2 running",
		);
	});

	test("writes nothing without a usable anchor", () => {
		expect(span({ isStreaming: true, totalMs: undefined, turnStartedAt: undefined })).toBe("");
		expect(span({ isStreaming: true, totalMs: undefined, turnStartedAt: "not-a-date" })).toBe("");
	});

	test("ignores the sealed fields while streaming", () => {
		// A sealed total can precede the seal of the turn (tool durations land
		// early); the live span still wins so the header does not jump.
		expect(span({ isStreaming: true, totalMs: 12000, runningTools: 1 })).toBe("working for 12s · 1 running");
	});
});
