// ============================================================================
// sessionTime — the row's time slot: the run's duration while an execution is
// in flight, recency otherwise, and the <time> instant naming the same thing
// the text does.
// ============================================================================

import { describe, expect, test } from "vitest";
import type { SessionInfo } from "../../../../src/core/index.ts";
import { sessionTime } from "./sessionTime.ts";

const NOW = Date.parse("2026-11-03T14:05:00.000Z");

/** An instant `minutesAgo` before the fixed clock. */
function at(minutesAgo: number): string {
	return new Date(NOW - minutesAgo * 60_000).toISOString();
}

function row(fields: Partial<SessionInfo>): SessionInfo {
	return {
		projectId: "proj",
		sessionId: "sess-1",
		stem: "s1",
		location: "inbox",
		timestamp: at(0),
		...fields,
	};
}

describe("sessionTime", () => {
	test("a running row counts from the human's last message", () => {
		const time = sessionTime(
			row({ activity: { kind: "responding" }, lastUserActivity: at(12), lastAgentActivity: at(0) }),
			NOW,
		);
		expect(time.text).toBe("12m");
		expect(time.when).toBe(at(12));
	});

	test("the agent's fresh entries do not restart the run clock", () => {
		// A streaming turn stamps an assistant entry every second; only the
		// human's message may move the start.
		const time = sessionTime(
			row({
				activity: { kind: "tool", name: "bash", startedAt: at(0) },
				lastUserActivity: at(45),
				lastAgentActivity: at(0),
			}),
			NOW,
		);
		expect(time.text).toBe("45m");
	});

	test("a running row with no user entry falls back to recency", () => {
		// A recovery run has no message behind it: no start to count from.
		const time = sessionTime(row({ activity: { kind: "responding" }, lastAgentActivity: at(3) }), NOW);
		expect(time.text).toBe("3 min ago");
		expect(time.when).toBe(at(3));
	});

	test("a settled row reads the agent's last word", () => {
		const time = sessionTime(row({ lastUserActivity: at(20), lastAgentActivity: at(5) }), NOW);
		expect(time.text).toBe("5 min ago");
		expect(time.when).toBe(at(5));
	});

	test("a Session nothing answered yet reads the human's word", () => {
		const time = sessionTime(row({ lastUserActivity: at(2) }), NOW);
		expect(time.text).toBe("2 min ago");
		expect(time.when).toBe(at(2));
	});

	test("a row with no message at all falls back to its sort-time stamp", () => {
		const time = sessionTime(row({ timestamp: at(30) }), NOW);
		expect(time.text).toBe("30 min ago");
		expect(time.when).toBe(at(30));
	});
});
