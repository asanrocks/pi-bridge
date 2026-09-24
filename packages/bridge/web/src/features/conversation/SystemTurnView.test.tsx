// SystemTurnView — the unrecognized-entry fallback. Proves the projection's
// unknown system turn reaches the view with its source type and the raw source
// entry, so an entry the projection cannot classify is shown rather than
// dropped.
//
// Lives under web/ (not test/suite/) because it imports .tsx components;
// root tsgo has no --jsx, so it is type-checked by check:bridge-web instead.

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
});
