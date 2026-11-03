// formatGroupSpan — the action group header's elapsed time. The wall-clock rule
// is the point: earliest call to latest result, so a parallel batch counts once
// and a sequential pair covers the gap between them.

import { describe, expect, test } from "vitest";
import { formatGroupSpan, type GroupSpanAction } from "./formatGroupSpan.ts";

const NOW = Date.parse("2026-11-03T14:05:00Z");

function settled(callAt: string, resultAt: string, durationMs: number | null = null): GroupSpanAction {
	return { status: "done", callSealedAt: callAt, resultSealedAt: resultAt, durationMs, runningElapsedMs: undefined };
}

describe("formatGroupSpan — settled group", () => {
	test("spans one call from its issue seal to its result seal", () => {
		expect(formatGroupSpan([settled("2026-11-03T14:04:40Z", "2026-11-03T14:05:00Z")], NOW)).toBe("took 20s");
	});

	test("counts a parallel batch once", () => {
		// Both issued together; the slow one ends 20s later. Wall clock, so the
		// answer is 20s, not the 30s a duration sum would produce.
		expect(
			formatGroupSpan(
				[
					settled("2026-11-03T14:04:40Z", "2026-11-03T14:04:50Z", 10_000),
					settled("2026-11-03T14:04:40Z", "2026-11-03T14:05:00Z", 20_000),
				],
				NOW,
			),
		).toBe("took 20s");
	});

	test("includes the gap between sequential calls", () => {
		expect(
			formatGroupSpan(
				[
					settled("2026-11-03T14:04:40Z", "2026-11-03T14:04:45Z"),
					settled("2026-11-03T14:04:50Z", "2026-11-03T14:05:00Z"),
				],
				NOW,
			),
		).toBe("took 20s");
	});

	test("falls back to pi's duration when the issue seal is missing", () => {
		expect(formatGroupSpan([settled("", "2026-11-03T14:05:00Z", 4_000)], NOW)).toBe("took 4s");
	});

	test("writes nothing when no call can be placed in time", () => {
		expect(formatGroupSpan([], NOW)).toBe("");
		expect(formatGroupSpan([settled("", "")], NOW)).toBe("");
	});
});

describe("formatGroupSpan — running group", () => {
	test("ticks the host-anchored elapsed and says so", () => {
		expect(
			formatGroupSpan(
				[{ status: "running", callSealedAt: "", resultSealedAt: "", durationMs: null, runningElapsedMs: 4_000 }],
				NOW,
			),
		).toBe("running 4s");
	});

	test("a running call extends a settled span", () => {
		expect(
			formatGroupSpan(
				[
					settled("2026-11-03T14:04:40Z", "2026-11-03T14:04:50Z"),
					{ status: "running", callSealedAt: "", resultSealedAt: "", durationMs: null, runningElapsedMs: 4_000 },
				],
				NOW,
			),
		).toBe("running 20s");
	});

	test("ignores a dispatched call with no anchor yet", () => {
		// Pending (arguments still streaming) and running-without-anchor both
		// contribute nothing rather than guessing a start.
		expect(
			formatGroupSpan(
				[
					{
						status: "pending",
						callSealedAt: "",
						resultSealedAt: "",
						durationMs: null,
						runningElapsedMs: undefined,
					},
					{
						status: "running",
						callSealedAt: "",
						resultSealedAt: "",
						durationMs: null,
						runningElapsedMs: undefined,
					},
				],
				NOW,
			),
		).toBe("");
	});
});
