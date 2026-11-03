// time — the label ladder, the full instant, and durations.
//
// Every fixture is built from local-time components and the clock is passed in
// explicitly, so these assertions hold in any timezone and at any wall-clock
// time. The ladder is a product contract (docs/web/design.md, Styling
// Invariants): relative while freshness is the question, then a clock, then a
// weekday, then a date.

import { describe, expect, test } from "vitest";
import { classifyInstant, formatDuration, formatSpan, formatWhen, formatWhenFull } from "./time.ts";

/** Local wall-clock instant as ISO. */
function iso(y: number, m: number, d: number, h: number, min: number): string {
	return new Date(y, m, d, h, min).toISOString();
}

/** Tuesday, 2026-11-03 14:05 local. */
const NOW = new Date(2026, 10, 3, 14, 5).getTime();

describe("formatWhen — the label ladder", () => {
	test("relative while the row is fresh", () => {
		expect(formatWhen(new Date(NOW - 30000).toISOString(), NOW)).toBe("just now");
		expect(formatWhen(new Date(NOW - 60000).toISOString(), NOW)).toBe("1 min ago");
		expect(formatWhen(iso(2026, 10, 3, 14, 0), NOW)).toBe("5 min ago");
		expect(formatWhen(iso(2026, 10, 3, 13, 6), NOW)).toBe("59 min ago");
	});

	test("freshness outranks the calendar just after midnight", () => {
		// 00:10 now, 23:40 yesterday: "30 min ago" beats "yesterday, 23:40".
		const midnight = new Date(2026, 10, 3, 0, 10).getTime();
		expect(formatWhen(iso(2026, 10, 2, 23, 40), midnight)).toBe("30 min ago");
	});

	test("clock for the rest of today, so the day is never ambiguous", () => {
		expect(formatWhen(iso(2026, 10, 3, 12, 5), NOW)).toBe("12:05");
		// Exactly one hour old is no longer "recent".
		expect(formatWhen(iso(2026, 10, 3, 13, 5), NOW)).toBe("13:05");
		// Midnight is 00:00, never 24:00.
		expect(formatWhen(iso(2026, 10, 3, 0, 0), NOW)).toBe("00:00");
	});

	test("weekday for this rolling week", () => {
		expect(formatWhen(iso(2026, 10, 2, 14, 5), NOW)).toBe("yesterday, 14:05");
		expect(formatWhen(iso(2026, 9, 31, 14, 5), NOW)).toBe("Sat, 14:05");
		expect(formatWhen(iso(2026, 9, 30, 9, 30), NOW)).toBe("Fri, 09:30");
	});

	test("date once the week is past, with the year only when it differs", () => {
		expect(formatWhen(iso(2026, 9, 24, 9, 30), NOW)).toBe("Oct 24");
		// Exactly seven days back is already outside the rolling window.
		expect(formatWhen(new Date(NOW - 7 * 86400000).toISOString(), NOW)).toBe("Oct 27");
		expect(formatWhen(iso(2025, 10, 3, 14, 5), NOW)).toBe("Nov 3, 2025");
	});

	test("unparseable input writes nothing", () => {
		expect(formatWhen("", NOW)).toBe("");
		expect(formatWhen("not-a-date", NOW)).toBe("");
	});
});

describe("classifyInstant — the bucket boundaries", () => {
	test("maps an instant to its kind", () => {
		expect(classifyInstant(iso(2026, 10, 3, 14, 4), NOW)).toBe("recent");
		expect(classifyInstant(iso(2026, 10, 3, 9, 0), NOW)).toBe("today");
		expect(classifyInstant(iso(2026, 10, 2, 23, 0), NOW)).toBe("yesterday");
		expect(classifyInstant(iso(2026, 9, 30, 14, 5), NOW)).toBe("thisWeek");
		expect(classifyInstant(iso(2026, 9, 20, 14, 5), NOW)).toBe("older");
	});

	test("the rolling week ends one hour short of the calendar-week trap", () => {
		// "This week" is the widest span whose labels can still name a weekday,
		// so bucket membership and the label form always agree.
		expect(classifyInstant(new Date(NOW - 7 * 86400000 + 60000).toISOString(), NOW)).toBe("thisWeek");
		expect(classifyInstant(new Date(NOW - 7 * 86400000).toISOString(), NOW)).toBe("older");
	});

	test("unparseable input has no kind", () => {
		expect(classifyInstant("", NOW)).toBeNull();
		expect(classifyInstant("2026-13-45", NOW)).toBeNull();
	});
});

describe("formatWhenFull — the hover and accessible truth", () => {
	test("carries the date, the 24h clock, and the zone", () => {
		const full = formatWhenFull(iso(2026, 10, 3, 14, 5));
		expect(full).toMatch(/^Nov 3, 2026, 14:05\b/);
		// A zone token follows the clock; which one depends on the machine.
		expect(full.slice("Nov 3, 2026, 14:05".length).trim()).not.toBe("");
	});

	test("unparseable input writes nothing", () => {
		expect(formatWhenFull("")).toBe("");
		expect(formatWhenFull("nope")).toBe("");
	});
});

describe("formatSpan — the turn-header estimate", () => {
	test("is coarser than a measured run: no sub-second decimal", () => {
		expect(formatSpan(400)).toBe("<1s");
		expect(formatSpan(12000)).toBe("12s");
	});

	test("keeps minutes and hours short", () => {
		expect(formatSpan(60000)).toBe("1m");
		expect(formatSpan(123000)).toBe("2m 3s");
		expect(formatSpan(3600000)).toBe("1h");
		expect(formatSpan(3900000)).toBe("1h 5m");
	});

	test("writes nothing for a missing or unusable span", () => {
		expect(formatSpan(undefined)).toBe("");
		expect(formatSpan(-1)).toBe("");
		expect(formatSpan(Number.NaN)).toBe("");
	});
});

describe("formatDuration", () => {
	test("one decimal below ten seconds, whole seconds below a minute", () => {
		expect(formatDuration(0)).toBe("0.0s");
		expect(formatDuration(1234)).toBe("1.2s");
		expect(formatDuration(12340)).toBe("12s");
		expect(formatDuration(59000)).toBe("59s");
	});

	test("minutes and hours, with zero remainders folded away", () => {
		expect(formatDuration(60000)).toBe("1m");
		expect(formatDuration(123000)).toBe("2m 03s");
		expect(formatDuration(3600000)).toBe("1h");
		expect(formatDuration(3900000)).toBe("1h 05m");
	});

	test("unusable input writes nothing", () => {
		expect(formatDuration(-1)).toBe("");
		expect(formatDuration(Number.NaN)).toBe("");
		expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("");
	});
});
