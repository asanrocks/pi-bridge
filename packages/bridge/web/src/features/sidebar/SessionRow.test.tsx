// ============================================================================
// SessionRow — the row's mark and its menu: the menu is shaped by the current
// location, Park/Unpark walk between Inbox and Later, Archive/Unarchive is the
// resting place, and a running row names the stop it performs while an idle one
// does not.
// ============================================================================

import { describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../../../../src/core/index.ts";
import { markOf, sessionMenuItems } from "./SessionRow.tsx";

function session(location: SessionInfo["location"], running = false): SessionInfo {
	return {
		projectId: "proj",
		sessionId: "sess-1",
		stem: "s1",
		location,
		timestamp: "2026-01-01T00:00:00.000Z",
		...(running ? { activity: { kind: "responding" as const } } : {}),
	};
}

describe("markOf", () => {
	it("reports running over any location", () => {
		expect(markOf(session("later", true))).toBe("running");
		expect(markOf(session("archive", true))).toBe("running");
	});

	it("reports the location when nothing is executing", () => {
		expect(markOf(session("inbox"))).toBe("inbox");
		expect(markOf(session("later"))).toBe("later");
		expect(markOf(session("archive"))).toBe("archive");
	});
});

describe("sessionMenuItems", () => {
	const labels = (items: ReturnType<typeof sessionMenuItems>) => items.map((item) => item.label);
	const byKey = (items: ReturnType<typeof sessionMenuItems>, key: string) => items.find((item) => item.key === key);

	it("walks Inbox and Later with Park and Unpark, and Archive with Unarchive", () => {
		expect(labels(sessionMenuItems(session("inbox"), () => {}))).toEqual(["Park", "Archive"]);
		expect(labels(sessionMenuItems(session("later"), () => {}))).toEqual(["Unpark", "Archive"]);
		expect(labels(sessionMenuItems(session("archive"), () => {}))).toEqual(["Unarchive"]);
	});

	it("names the stop only while an agent is running", () => {
		expect(
			labels(
				sessionMenuItems(
					session("inbox"),
					() => {},
					() => {},
				),
			),
		).toEqual(["Park", "Archive", "Trash"]);
		expect(
			labels(
				sessionMenuItems(
					session("inbox", true),
					() => {},
					() => {},
				),
			),
		).toEqual(["Park", "Stop and archive", "Stop and trash"]);
	});

	it("keeps the reclassifying moves unqualified while running", () => {
		expect(labels(sessionMenuItems(session("later", true), () => {}))).toEqual(["Unpark", "Stop and archive"]);
		expect(labels(sessionMenuItems(session("archive", true), () => {}))).toEqual(["Unarchive"]);
	});

	it("carries no detail line: the label is the whole claim", () => {
		const items = sessionMenuItems(
			session("inbox", true),
			() => {},
			() => {},
		);
		expect(items.every((item) => item.detail === undefined)).toBe(true);
	});

	it("wears the danger tone on Trash always and on the stop-labelled moves only", () => {
		const idle = sessionMenuItems(
			session("inbox"),
			() => {},
			() => {},
		);
		expect(idle.map((item) => item.danger === true)).toEqual([false, false, true]);
		const running = sessionMenuItems(
			session("inbox", true),
			() => {},
			() => {},
		);
		expect(running.map((item) => item.danger === true)).toEqual([false, true, true]);
	});

	it("puts Trash last, under the divider", () => {
		const items = sessionMenuItems(
			session("later"),
			() => {},
			() => {},
		);
		expect(items.map((item) => item.key)).toEqual(["unpark", "archive", "trash"]);
		expect(items.filter((item) => item.separator === true).map((item) => item.key)).toEqual(["trash"]);
	});

	it("reports the location each move lands in", () => {
		for (const [location, expected] of [
			["inbox", { park: "later", archive: "archive" }],
			["later", { unpark: "inbox", archive: "archive" }],
			["archive", { unarchive: "later" }],
		] as const) {
			const onMove = vi.fn();
			const items = sessionMenuItems(session(location), onMove);
			for (const [key, target] of Object.entries(expected)) {
				byKey(items, key)?.onSelect();
				expect(onMove).toHaveBeenLastCalledWith(target);
			}
		}
	});

	it("is empty when the row offers no actions (the panel has no menu)", () => {
		expect(sessionMenuItems(session("inbox"))).toEqual([]);
	});
});
