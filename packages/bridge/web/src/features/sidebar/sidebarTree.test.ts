// ============================================================================
// sidebarTree — the Project's rows as one tree, then split by each root's
// place: nesting follows the stems, so a child is drawn under its spawner even
// when their places differ, and only a descendant more attentive than its
// ancestor becomes a root of its own group. A row without a place of its own is
// drawn only while it works or while the reader has it or its spawner open.
// ============================================================================

import { describe, expect, it } from "vitest";
import type { SessionInfo, SessionLocation } from "../../../../src/core/index.ts";
import { buildSidebarTree, parentStemOf, type SidebarView } from "./sidebarTree.ts";

function row(stem: string, location: SessionLocation = "inbox", running = false): SessionInfo {
	return {
		projectId: "p",
		sessionId: `id-${stem}`,
		stem,
		location,
		timestamp: "2026-01-01T00:00:00.000Z",
		...(running ? { activity: { kind: "responding" as const } } : {}),
	};
}

const NOTHING_OPEN: SidebarView = { viewedStem: null };

function tree(
	rows: { inbox?: SessionInfo[]; later?: SessionInfo[]; archived?: SessionInfo[]; agent?: SessionInfo[] },
	view: SidebarView = NOTHING_OPEN,
) {
	return buildSidebarTree({ inbox: [], later: [], archived: [], agent: [], ...rows }, view);
}

const shape = (rows: ReturnType<typeof tree>["inbox"]) =>
	rows.map((r) => [r.session.stem, r.depth, r.childCount] as const);

const stems = (rows: ReturnType<typeof tree>["inbox"]) => rows.map((r) => r.session.stem);

describe("parentStemOf", () => {
	it("names the directory a spawned Session is stored under", () => {
		expect(parentStemOf("2026-01-01_root")).toBeUndefined();
		expect(parentStemOf("2026-01-01_root/2026-01-01_child")).toBe("2026-01-01_root");
		expect(parentStemOf("a/b/c")).toBe("a/b");
	});
});

describe("buildSidebarTree", () => {
	it("puts a child directly after its parent, one level deeper", () => {
		const { inbox } = tree({ inbox: [row("root"), row("root/child"), row("other")] });
		expect(shape(inbox)).toEqual([
			["root", 0, 1],
			["root/child", 1, 0],
			["other", 0, 0],
		]);
	});

	it("counts direct children drawn under the row, not descendants", () => {
		const { inbox } = tree({ inbox: [row("root"), row("root/a"), row("root/a/b")] });
		expect(shape(inbox)).toEqual([
			["root", 0, 1],
			["root/a", 1, 1],
			["root/a/b", 2, 0],
		]);
	});

	it("draws a live agent row under its spawner while the reader is there", () => {
		// The queue slice carries the live child as an archive row: it is visible
		// while its tree is being read, but it is not an Inbox or Later member.
		const { inbox, archived } = tree(
			{ inbox: [row("root")], agent: [row("root/worker", "archive")] },
			{
				viewedStem: "root",
			},
		);
		expect(shape(inbox)).toEqual([
			["root", 0, 1],
			["root/worker", 1, 0],
		]);
		expect(archived).toEqual([]);
	});

	it("draws every top-level archived Session, spawned or not", () => {
		// The archived tail is the user's own history; only ambient descendants wait.
		const { archived } = tree({ archived: [row("old", "archive")] });
		expect(stems(archived)).toEqual(["old"]);
	});

	it("hides an idle agent row once the reader moves elsewhere", () => {
		// Ambient work does not accumulate in the rail: the child is still a Session
		// with a file, it just does not own a row while nobody is looking at it.
		const rows = { inbox: [row("root"), row("other")], agent: [row("root/worker", "archive")] };
		expect(stems(tree(rows, { viewedStem: "other" }).inbox)).toEqual(["root", "other"]);
		expect(stems(tree(rows, NOTHING_OPEN).inbox)).toEqual(["root", "other"]);
	});

	it("draws a busy agent row wherever the reader is", () => {
		const { inbox } = tree(
			{ inbox: [row("root")], agent: [row("root/worker", "archive", true)] },
			{
				viewedStem: "elsewhere",
			},
		);
		expect(shape(inbox)).toEqual([
			["root", 0, 1],
			["root/worker", 1, 0],
		]);
	});

	it("draws the Session being read even though nothing placed it", () => {
		// Reading a spawned Session must not hide the row that says where the
		// reader is; its own children are drawn with it.
		const { inbox } = tree(
			{ inbox: [row("root")], agent: [row("root/worker", "archive"), row("root/worker/leaf", "archive")] },
			{ viewedStem: "root/worker" },
		);
		expect(shape(inbox)).toEqual([
			["root", 0, 1],
			["root/worker", 1, 1],
			["root/worker/leaf", 2, 0],
		]);
	});

	it("draws a grandchild only when it is working or being read", () => {
		// The rule is about direct children: viewing the root shows its workers,
		// not their workers.
		const rows = {
			inbox: [row("root")],
			agent: [row("root/worker", "archive"), row("root/worker/leaf", "archive")],
		};
		expect(stems(tree(rows, { viewedStem: "root" }).inbox)).toEqual(["root", "root/worker"]);
	});

	it("keeps a placed child drawn, so the rail cannot hide attention", () => {
		// A user's prompt promotes a spawned Session like any other message; hiding
		// it would leave the folder's Inbox count reporting a row nobody can see.
		const { inbox } = tree({ inbox: [row("root"), row("root/promoted")] }, { viewedStem: "elsewhere" });
		expect(stems(inbox)).toEqual(["root", "root/promoted"]);
	});

	it("keeps a less attentive child inside its spawner's group", () => {
		// The spawner is Inbox, the child was parked or archived: the tree still
		// groups them together while the spawner is being read.
		const { inbox, later, archived } = tree(
			{
				inbox: [row("root")],
				later: [row("root/parked", "later")],
				archived: [row("root/done", "archive")],
			},
			{ viewedStem: "root" },
		);
		expect(shape(inbox)).toEqual([
			["root", 0, 2],
			["root/parked", 1, 0],
			["root/done", 1, 0],
		]);
		expect(later).toEqual([]);
		expect(archived).toEqual([]);
	});

	it("promotes a descendant more attentive than its ancestor to a root of its own group", () => {
		// Work that returned to Inbox must not disappear inside a parked tree.
		const laterParent = row("root", "later");
		const { inbox, later } = tree({
			inbox: [row("root/child")],
			later: [laterParent],
		});
		expect(shape(inbox)).toEqual([["root/child", 0, 0]]);
		expect(inbox[0].promotedParent).toBe(laterParent);
		expect(inbox[0].parentStem).toBe("root");
		expect(shape(later)).toEqual([["root", 0, 0]]);
	});

	it("carries descendants into their root's group", () => {
		const { later, archived } = tree(
			{ later: [row("parked", "later")], archived: [row("parked/child", "archive")] },
			{ viewedStem: "parked" },
		);
		expect(shape(later)).toEqual([
			["parked", 0, 1],
			["parked/child", 1, 0],
		]);
		expect(archived).toEqual([]);
	});

	it("leaves a child whose spawner is not rendered at depth 0 with the reference", () => {
		// The parent's page is not loaded: nothing can nest under a row that is not
		// on screen, and the jump still knows the address.
		const { inbox } = tree({ inbox: [row("root/child")] });
		expect(shape(inbox)).toEqual([["root/child", 0, 0]]);
		expect(inbox[0].parentStem).toBe("root");
		expect(inbox[0].promotedParent).toBeUndefined();
	});

	it("keeps the input order among siblings and roots", () => {
		const { inbox } = tree({ inbox: [row("root/b"), row("root"), row("root/a")] });
		expect(inbox.map((r) => r.session.stem)).toEqual(["root", "root/b", "root/a"]);
	});
});
