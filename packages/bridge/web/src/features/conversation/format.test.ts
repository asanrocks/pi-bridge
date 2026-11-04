// format — the live status line of a streaming turn and the ledger's
// approximation mark. Sealed durations are statistics now (ADR 21), so the
// wording this pins is the in-flight one (the live span plus the running-tool
// count) and the `~` that replaces a footnote about estimated durations.

import { describe, expect, test } from "vitest";
import { formatEstimate, formatLiveStatus, formatReportedSpan } from "./format.ts";

const NOW = new Date(2026, 10, 3, 14, 5).getTime();

function status(input: Partial<Parameters<typeof formatLiveStatus>[0]>): string {
	return formatLiveStatus({
		turnStartedAt: new Date(NOW - 12000).toISOString(),
		runningTools: 0,
		now: NOW,
		...input,
	});
}

describe("formatEstimate — the ledger's approximation mark", () => {
	test("prefixes a span with a tilde instead of a footnote", () => {
		expect(formatEstimate("1m 19s")).toBe("~1m 19s");
		expect(formatEstimate("55s")).toBe("~55s");
	});

	test("a bound is already approximate and takes no tilde", () => {
		expect(formatEstimate("<1s")).toBe("<1s");
	});

	test("nothing stays nothing", () => {
		expect(formatEstimate("")).toBe("");
	});
});

describe("formatReportedSpan — only a span worth a row", () => {
	test("a zero reading is absent, not <1s", () => {
		// A tool-free turn resolves its share to 0 and an instant reply resolves the
		// gap to 0; formatSpan would render both as a confident "<1s".
		expect(formatReportedSpan(0)).toBe("");
		expect(formatReportedSpan(undefined)).toBe("");
	});

	test("a sub-second span is noise", () => {
		expect(formatReportedSpan(999)).toBe("");
	});

	test("a real span is estimated", () => {
		expect(formatReportedSpan(1000)).toBe("~1s");
		expect(formatReportedSpan(55000)).toBe("~55s");
	});
});

describe("formatLiveStatus", () => {
	test("ticks a live span from the turn anchor", () => {
		expect(status({})).toBe("working for 12s");
	});

	test("counts the running tools beside it", () => {
		expect(status({ runningTools: 2 })).toBe("working for 12s · 2 running");
	});

	test("writes nothing without a usable anchor", () => {
		expect(status({ turnStartedAt: undefined })).toBe("");
		expect(status({ turnStartedAt: "not-a-date" })).toBe("");
	});
});
