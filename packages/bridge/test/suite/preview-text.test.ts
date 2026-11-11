// preview-text — the one-line display text a listing row carries: Markdown
// markers stripped, whitespace collapsed, and a 120-character cap. This is a
// label, not a renderer, so the rules are syntactic and conservative: a marker
// left behind is cheaper than a mangled identifier or arithmetic asterisk.

import { describe, expect, it } from "vitest";
import { clampPreview } from "../../src/host/session-actor.ts";

describe("clampPreview", () => {
	it("collapses to one line and caps at 120 characters", () => {
		expect(clampPreview("first line\nsecond\tline")).toBe("first line second line");
		const long = "word ".repeat(40);
		expect(clampPreview(long)).toHaveLength(120);
		expect(clampPreview(long).endsWith("…")).toBe(true);
	});

	it("drops headings, quotes, bullets, task boxes, and ordered markers", () => {
		expect(clampPreview("## Fix the parser")).toBe("Fix the parser");
		expect(clampPreview("> quoted")).toBe("quoted");
		expect(clampPreview("- bullet")).toBe("bullet");
		expect(clampPreview("- [ ] queued task")).toBe("queued task");
		expect(clampPreview("3. third")).toBe("third");
	});

	it("drops the fence line and keeps the code it guards", () => {
		expect(clampPreview("```ts\nconst x = 1\n```")).toBe("const x = 1");
		expect(clampPreview("---")).toBe("");
	});

	it("keeps the label of a link or image and the content of code", () => {
		expect(clampPreview("see [web design](https://example.com/x) now")).toBe("see web design now");
		expect(clampPreview("![screenshot](screen.png)")).toBe("screenshot");
		expect(clampPreview("use `formatSpan` here")).toBe("use formatSpan here");
	});

	it("drops emphasis and strikethrough delimiters but keeps their words", () => {
		expect(clampPreview("**bold** and *italic* and ~~gone~~")).toBe("bold and italic and gone");
		expect(clampPreview("_also italic_")).toBe("also italic");
	});

	it("leaves markers alone where they are not markup", () => {
		// Identifiers, arithmetic, and issue references keep their characters.
		expect(clampPreview("snake_case_name")).toBe("snake_case_name");
		expect(clampPreview("a * b and 2*3")).toBe("a * b and 2*3");
		expect(clampPreview("#123 is the issue")).toBe("#123 is the issue");
		expect(clampPreview("a < b > c")).toBe("a < b > c");
	});

	it("drops HTML tags and turns table pipes into word breaks", () => {
		expect(clampPreview("<b>bold</b> text")).toBe("bold text");
		expect(clampPreview("| a | b |")).toBe("a b");
	});

	it("stays inside the preview's own budget on a hostile single line", () => {
		// The visible text is the first 120 characters either way; the bound keeps
		// a long marker-dense line from being scanned in full.
		expect(clampPreview(`**${"a ".repeat(50_000)}`)).toHaveLength(120);
	});

	it("strips before capping, so markers do not eat the preview", () => {
		const bold = `**${"x".repeat(200)}**`;
		expect(clampPreview(bold)).toHaveLength(120);
		expect(clampPreview(bold).startsWith("xxx")).toBe(true);
	});
});
