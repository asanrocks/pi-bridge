// ============================================================================
// SessionRow — the row's mark, its time slot, and its menu: the menu is shaped
// by the current location, Park/Unpark walk between Inbox and Later,
// Archive/Unarchive is the resting place, and a running row names the stop it
// performs while an idle one does not. The time slot reports the run clock
// while an execution is in flight and recency otherwise.
// ============================================================================

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, test, vi } from "vitest";
import type { SessionInfo } from "../../../../src/core/index.ts";
import { formatWhenFull } from "../../infra/lib/time.ts";
import { markOf, SessionRow, sessionMenuItems } from "./SessionRow.tsx";

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

describe("SessionRow — the time slot", () => {
	// The shared clock's server snapshot is read at import time, i.e. before this
	// instant, so fixtures sit half a minute past the minute they name: the
	// recency label floors, and the reading must not tip into the previous minute.
	const now = Date.now();
	const ago = (minutes: number) => new Date(now - minutes * 60_000 - 30_000).toISOString();

	function render(sessionInfo: SessionInfo): string {
		return renderToStaticMarkup(createElement(SessionRow, { session: sessionInfo, onOpen: () => {} }));
	}

	test("a running row counts its run from the human's last message", () => {
		const html = render({
			...session("inbox", true),
			lastUserActivity: ago(12),
			lastAgentActivity: new Date(now - 1000).toISOString(),
		});
		expect(html).toContain(">12m 30s</time>");
	});

	test("a settled row reports recency from the agent's last word", () => {
		const html = render({ ...session("inbox"), lastUserActivity: ago(20), lastAgentActivity: ago(5) });
		expect(html).toContain("5 min ago");
	});
});

describe("SessionRow — the second line and its hover titles", () => {
	const now = Date.now();
	const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

	function render(sessionInfo: SessionInfo): string {
		return renderToStaticMarkup(createElement(SessionRow, { session: sessionInfo, onOpen: () => {} }));
	}

	test("a running row chips the tool in front of the agent's words", () => {
		const html = render({
			...session("inbox", true),
			activity: { kind: "tool", name: "bash", startedAt: new Date(now - 3000).toISOString() },
			lastUserActivity: ago(12),
			lastAgentText: "Now the sessionTime test:",
		});
		expect(html).toContain(">bash<");
		expect(html).toContain("·");
		expect(html).toContain("Now the sessionTime test:");
		// The flat line is the hover title, so a narrow row still says all of it.
		expect(html).toContain('title="bash · ');
	});

	test("each line states its own fact instead of repeating the Session name", () => {
		const running: SessionInfo = {
			...session("inbox", true),
			name: "the parser",
			activity: { kind: "responding" },
			lastUserActivity: ago(12),
			lastAgentText: "Now the sessionTime test:",
		};
		const html = render(running);
		// The name, the line's own text, and the precise instant — never the name
		// three times over.
		expect(html).toContain('title="the parser"');
		expect(html).toContain('title="Now the sessionTime test:"');
		expect(html).toContain(`title="${formatWhenFull(running.lastUserActivity ?? "")}"`);
	});

	test("an Inbox preview carries its full line as the title", () => {
		const html = render({ ...session("inbox"), lastMessageText: "the reply, in full" });
		expect(html).toContain('title="the reply, in full"');
	});
});
