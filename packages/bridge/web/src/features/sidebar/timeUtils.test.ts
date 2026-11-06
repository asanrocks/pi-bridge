// timeUtils — sidebar time bucketing. The bucket boundaries come from the same
// classifier the row labels use, so the two can never disagree; these tests pin
// that agreement rather than the individual date arithmetic.

import { describe, expect, test } from "vitest";
import type { SessionInfo } from "../../../../src/core/index.ts";
import { formatWhen } from "../../infra/lib/time.ts";
import { type GroupLabel, groupSessions, sessionGroup } from "./timeUtils.ts";

function iso(y: number, m: number, d: number, h: number, min: number): string {
	return new Date(y, m, d, h, min).toISOString();
}

/** Tuesday, 2026-11-03 14:05 local. */
const NOW = new Date(2026, 10, 3, 14, 5).getTime();

function session(stem: string, timestamp: string): SessionInfo {
	return { projectId: "p", sessionId: `id-${stem}`, stem, state: "inactive" as const, timestamp };
}

describe("sessionGroup", () => {
	test("maps the label classes onto the three headings", () => {
		expect(sessionGroup(iso(2026, 10, 3, 14, 0), NOW)).toBe("Today");
		expect(sessionGroup(iso(2026, 10, 2, 14, 0), NOW)).toBe("This week");
		expect(sessionGroup(iso(2026, 9, 24, 14, 0), NOW)).toBe("Earlier");
	});

	test("a fresh row just after midnight stays under Today", () => {
		const midnight = new Date(2026, 10, 3, 0, 10).getTime();
		expect(sessionGroup(iso(2026, 10, 2, 23, 40), midnight)).toBe("Today");
	});

	test("unparseable timestamps have no bucket", () => {
		expect(sessionGroup("", NOW)).toBeNull();
	});
});

describe("groupSessions", () => {
	test("orders buckets, sorts each newest-first, and drops unreadable rows", () => {
		const groups = groupSessions(
			[
				session("older", iso(2026, 9, 24, 14, 0)),
				session("today-old", iso(2026, 10, 3, 9, 0)),
				session("bad", "not-a-date"),
				session("today-new", iso(2026, 10, 3, 13, 0)),
				session("week", iso(2026, 9, 30, 14, 0)),
			],
			NOW,
		);
		expect(groups.map((g) => g.label)).toEqual(["Today", "This week", "Earlier"]);
		expect(groups[0]?.items.map((s) => s.stem)).toEqual(["today-new", "today-old"]);
		expect(groups[1]?.items.map((s) => s.stem)).toEqual(["week"]);
		expect(groups[2]?.items.map((s) => s.stem)).toEqual(["older"]);
	});

	test("every row's label matches the heading it sits under", () => {
		// The invariant the shared classifier buys: a heading never contradicts
		// the label of a row inside it.
		const shapes: Record<GroupLabel, RegExp> = {
			Today: /^(just now|\d+ min ago|\d{2}:\d{2})$/,
			"This week": /^(yesterday, \d{2}:\d{2}|\w{3}, \d{2}:\d{2})$/,
			Earlier: /^\w{3} \d{1,2}(, \d{4})?$/,
		};
		const stamps = [
			iso(2026, 10, 3, 14, 4),
			iso(2026, 10, 3, 13, 0),
			iso(2026, 10, 3, 9, 0),
			iso(2026, 10, 2, 14, 0),
			iso(2026, 9, 30, 14, 0),
			iso(2026, 9, 24, 14, 0),
			iso(2025, 9, 24, 14, 0),
		];
		for (const timestamp of stamps) {
			const label = formatWhen(timestamp, NOW);
			const group = sessionGroup(timestamp, NOW);
			expect(group).not.toBeNull();
			expect(label, `${timestamp} → ${group}`).toMatch(shapes[group as GroupLabel]);
		}
	});
});
