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
// tsc has no --jsx, so it is type-checked by check:bridge-web instead.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { HighlightResult } from "../../../render/shiki.ts";

vi.mock("../../../render/shiki.ts", () => ({
	highlightTokens: () => Promise.resolve({ bg: "transparent", fg: "inherit", lines: [] }),
}));

const { DiffSections, resolveSectionHighlights, tokensMatchLine } = await import("./DiffSections.tsx");

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

	describe("streaming highlight resolution — per-section stale-keep", () => {
		// The streaming flicker fix: a section whose content changed keeps the
		// previous render's highlight while the fresh one is in flight, instead
		// of the whole card dropping to plain text per chunk.
		const result = (lines: string[]): HighlightResult => ({
			fg: "inherit",
			darkFg: "inherit",
			lines: lines.map((t) => ({ tokens: [{ content: t }] })),
		});

		test("cached signature resolves fresh (not stale)", () => {
			const cache = new Map([["a", result(["x"] as string[])]]);
			expect(resolveSectionHighlights(["a"], cache, [null])).toEqual([{ result: cache.get("a"), stale: false }]);
		});

		test("changed section keeps the stale result at its index", () => {
			const stale = result(["old tail"]);
			const resolved = resolveSectionHighlights(["b"], new Map(), [stale]);
			expect(resolved).toEqual([{ result: stale, stale: true }]);
		});

		test("no stale baseline (first render) resolves plain-null stale", () => {
			expect(resolveSectionHighlights(["a"], new Map(), [])).toEqual([{ result: null, stale: true }]);
		});

		test("sibling sections are independent: cache hit next to a stale miss", () => {
			const cached = result(["stable file"]);
			const growing = result(["partial tail"]);
			const cache = new Map([["stable", cached]]);
			const resolved = resolveSectionHighlights(["stable", "growing-v2"], cache, [cached, growing]);
			expect(resolved[0]).toEqual({ result: cached, stale: false });
			expect(resolved[1]).toEqual({ result: growing, stale: true });
		});

		test("tokensMatchLine gates stale reuse on text alignment", () => {
			// Aligned: tokens concatenate back to the line's text.
			expect(tokensMatchLine([{ content: "print(" }, { content: ")" }], "print()")).toBe(true);
			// Misaligned (diff restructured, line indexes shifted): plain fallback.
			expect(tokensMatchLine([{ content: "print(" }], "print()")).toBe(false);
			// Empty line: no tokens, matching empty text.
			expect(tokensMatchLine([], "")).toBe(true);
		});
	});
});
