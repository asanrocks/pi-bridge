// SystemTurnView — the system-prompt turn renders as a read-style card: a
// tinted collapsible row named `System prompt update`, expanding to a details
// card with the changed sections and the prompt text highlighted as markdown.
// The unrecognized-entry fallback shows its source type and raw detail, so an
// entry the projection cannot classify is shown rather than dropped.
//
// Lives under web/ (not test/suite/) because it imports .tsx components;
// root tsc has no --jsx, so it is type-checked by check:bridge-web instead.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { SystemTurn } from "../../../../src/viewmodel/index.ts";

vi.mock("../../render/markdown.tsx", () => ({
	Markdown: ({ text }: { text: string }) => createElement("div", null, text),
}));

const { SystemTurnView } = await import("./SystemTurnView.tsx");

function render(turn: SystemTurn): string {
	return renderToStaticMarkup(createElement(SystemTurnView, { turn }));
}

describe("SystemTurnView — unrecognized entry fallback", () => {
	test("renders an unrecognized turn with its source type and raw detail", () => {
		const html = render({
			kind: "system",
			type: "unknown",
			entryId: "e1",
			index: 0,
			summary: "context_edit",
			detail: {
				kind: "custom",
				id: "e1",
				parentId: "u1",
				timestamp: "2024-01-01T00:00:00Z",
				customType: "context_edit",
				data: { type: "context_edit", targetId: "u1", replacement: null },
			},
		});
		expect(html).toContain("Unrecognized");
		expect(html).toContain("context_edit");
		// The raw entry is dumped, not just its type name.
		expect(html).toContain("targetId");
	});

	test("renders a prompt change as a collapsed read-style card", () => {
		const html = render({
			kind: "system",
			type: "system_prompt",
			entryId: "s1",
			index: 0,
			summary: "tools, rules",
			detail: {
				kind: "message",
				id: "s1",
				parentId: "a1",
				timestamp: "2024-01-01T00:00:00Z",
				role: "system",
				content: [],
				sections: { tools: "read, write", rules: "be nice" },
			},
		});
		// Collapsed by default: the row is named, not a list of sections.
		expect(html).toContain("System prompt update");
		expect(html).toContain("Expand System prompt update");
		// The section list and the prompt text live inside the card, not the row.
		expect(html).not.toContain("tools, rules");
		expect(html).not.toContain("read, write");
		expect(html).not.toContain("Unrecognized");
	});
});
