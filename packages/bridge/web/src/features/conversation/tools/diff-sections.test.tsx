// DiffSections — SSR tests for the shared unified-diff renderer's whole-file
// review options: context elision (a collapsed `⋯ N unchanged lines` row), the
// dual old/new line-number gutter, and the wrap opt-out. Card bodies pass none
// of these; the browser's review sections pass all three, because they diff
// fetched snapshots rather than git's already-elided patch.
//
// SSR runs no effects, so the shiki highlight result never lands and the
// renderer takes its plain-text path — the streaming/pre-highlight display.
//
// Lives under web/ (not test/suite/) because it imports .tsx components; root
// tsgo has no --jsx, so it is type-checked by check:bridge-web instead.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("../../../render/shiki.ts", () => ({
	highlightTokens: () => Promise.resolve({ bg: "transparent", fg: "inherit", lines: [] }),
}));

const { DiffSections } = await import("./DiffSections.tsx");

const OLD_TEXT = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
const NEW_TEXT = OLD_TEXT.replace("line 10", "line ten");

function render(options: { contextLines?: number; lineNumbers?: boolean; wrap?: boolean }): string {
	return renderToStaticMarkup(
		createElement(DiffSections, {
			sections: [{ title: null, lang: "", oldText: OLD_TEXT, newText: NEW_TEXT }],
			...options,
		}),
	);
}

describe("DiffSections whole-file review options", () => {
	test("without contextLines every line renders and no gap row appears", () => {
		const html = render({});
		expect(html).toContain("line 5");
		expect(html).not.toContain("unchanged lines");
		expect(html).not.toContain("editDiffGutter");
	});

	test("contextLines collapses long unchanged runs to head/tail context", () => {
		const html = render({ contextLines: 3 });
		// Both unchanged runs (before and after the change) are elided.
		expect(html).toContain("unchanged lines");
		// Head context of the first run and tail context of the second survive.
		expect(html).toContain("line 1");
		expect(html).toContain("line 3");
		expect(html).toContain("line 18");
		// The middle of the first run is collapsed away.
		expect(html).not.toContain("line 5");
		// The changed pair still renders both sides (single-line changes get
		// word-level highlighting, so the text is split into spans).
		expect(html).toContain("editDiffOld");
		expect(html).toContain("editDiffNew");
		expect(html).toContain(">10<");
		expect(html).toContain(">ten<");
	});

	test("lineNumbers renders the dual gutter", () => {
		const html = render({ lineNumbers: true, contextLines: 3 });
		expect(html).toContain("editDiffGutter");
		// The changed line's new-side number is 10 in the gutter (the old side
		// number is 10 too, so the row carries two 10s plus its text).
		expect(html).toContain(">10<");
	});

	test("wrap defaults on; wrap: false adds the no-wrap class", () => {
		expect(render({})).not.toContain("editDiffNoWrap");
		expect(render({ wrap: false })).toContain("editDiffNoWrap");
	});
});
