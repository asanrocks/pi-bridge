// ActionGroupView — the sticky ladder's markup contract (ADR 0017).
//
// `data-sticky-head` on the group header and on every action head is
// load-bearing outside this component: the rewrap-anchor probe in
// useViewportTracking skips such hits, because a pinned box's rect top is the pin
// offset rather than a document position (capturing it would make the restore
// target ambiguous).
//
// Lives under web/ (not test/suite/) because it imports a .tsx component; root
// tsc has no --jsx, so it is type-checked by check:bridge-web instead.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ActionVM, ToolActionVM } from "../../../../src/viewmodel/index.ts";

const harness = vi.hoisted(() => ({
	state: undefined as unknown,
}));

vi.mock("../../infra/state/store.tsx", () => ({
	useStore: (selector: (s: unknown) => unknown) => selector(harness.state),
}));

vi.mock("../viewer/AppMarkdown.tsx", () => ({
	AppMarkdown: ({ text }: { text: string }) => createElement("span", null, text),
}));

const { drainPullQueue } = await import("../../infra/net/pullQueue.ts");
const { ActionGroupView } = await import("./ActionGroupView.tsx");

const GROUP_KEY = "a1:b0";

/** One message entry holding two read calls, plus the store fields the group
 * and its action rows select. Expanded state is the only varying input. */
function setState(opts: { groupExpanded?: boolean } = {}): void {
	harness.state = {
		document: {
			entries: {
				a1: {
					kind: "message",
					id: "a1",
					content: [
						{ type: "toolCall", id: "t1", name: "read", arguments: { path: "src/a.ts" } },
						{ type: "toolCall", id: "t2", name: "read", arguments: { path: "src/b.ts" } },
					],
				},
			},
			status: { inFlightTools: undefined },
		},
		expandedActionGroups: new Set(opts.groupExpanded ? [GROUP_KEY] : []),
		frozenActionGroups: new Set<string>(),
		expandedActions: new Set<string>(),
		uncappedDetails: new Set<string>(),
		pullTick: 0,
		cardWrap: false,
		cardMarkdown: false,
		toggleCardWrap: () => {},
		toggleCardMarkdown: () => {},
		toggleUncapDetails: () => {},
		openFileViewer: () => {},
		activeSessionId: null,
		currentProjectId: undefined,
		projects: [],
	};
}

function action(blockIndex: number, toolCallId: string): ToolActionVM {
	return {
		blockType: "tool",
		entryId: "a1",
		blockIndex,
		toolName: "read",
		toolCallId,
		arguments: null,
		result: null,
		summary: "read: src/a.ts",
		status: "done",
	};
}

function render(opts: { groupExpanded?: boolean } = {}): string {
	setState(opts);
	const actions: ActionVM[] = [action(0, "t1"), action(1, "t2")];
	return renderToStaticMarkup(
		createElement(ActionGroupView, {
			groupKey: GROUP_KEY,
			actions,
			isTrailing: false,
			onToggleGroup: () => {},
			onToggleAction: () => {},
		}),
	);
}

beforeEach(() => {
	drainPullQueue();
});

describe("ActionGroupView — sticky ladder contract", () => {
	test("an expanded group marks its header and every action head sticky", () => {
		const html = render({ groupExpanded: true });

		expect(html.match(/data-sticky-head="true"/g)).toHaveLength(3); // group header + two action heads
	});

	test("a collapsed group renders its sticky header alone", () => {
		const html = render();

		expect(html.match(/data-sticky-head="true"/g)).toHaveLength(1);
		expect(html).toContain("read 2 files");
	});
});
