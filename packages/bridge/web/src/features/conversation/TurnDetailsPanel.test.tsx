// TurnDetailsPanel — the ledger anatomy, tested at the markup level
// (renderToStaticMarkup): three hairline-separated sections of labelled rows,
// every value with its subject. The labels are the contract here — the readings
// are heterogeneous, so an unlabelled "15%" would say nothing.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { TurnDetailsPanel } from "./TurnDetailsPanel.tsx";

function render(sections: Parameters<typeof TurnDetailsPanel>[0]["sections"]): string {
	return renderToStaticMarkup(createElement(TurnDetailsPanel, { anchor: null, sections, onClose: () => {} }));
}

describe("TurnDetailsPanel", () => {
	test("each section is its own list, so the divider can group them", () => {
		const html = render([
			{
				rows: [
					{ label: "Model", value: "GLM-5.3" },
					{ label: "Provider", value: "Z.ai" },
				],
			},
			{ rows: [{ label: "Context", value: "15% (+11%)" }] },
			{ rows: [{ label: "Duration", value: "~1m 19s" }] },
		]);
		expect(html.match(/<dl/g)).toHaveLength(3);
	});

	test("every value keeps its label", () => {
		const html = render([
			{ rows: [{ label: "Context", value: "15% (+11%)" }] },
			{ rows: [{ label: "Tools", value: "~55s" }] },
		]);
		expect(html).toContain("Context");
		expect(html).toContain(">15% (+11%)<");
		expect(html).toContain("Tools");
		expect(html).toContain(">~55s<");
	});

	test("an omitted reading is absent rather than zero", () => {
		const html = render([{ rows: [{ label: "Time", value: "Nov 4, 2026, 20:54 GMT+8" }] }]);
		expect(html).not.toContain("Duration");
		expect(html).not.toContain("0s");
	});

	test("the panel is a named information surface, not an action menu", () => {
		expect(render([{ rows: [{ label: "Time", value: "now" }] }])).toContain('role="dialog"');
	});
});
