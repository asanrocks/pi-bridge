// AnchoredMenu — the shared action list, tested at the markup level
// (renderToStaticMarkup). Two contracts: every row is one `menuitem` (there is
// no checkable row, because a setting that flips on the press is a switch in a
// dialog), and a refused command keeps its place with its reason inline.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { AnchoredMenu, type MenuItem } from "./AnchoredMenu.tsx";

function render(items: MenuItem[]): string {
	return renderToStaticMarkup(
		createElement(AnchoredMenu, { anchor: null, items, onClose: () => {}, label: "Actions" }),
	);
}

const items: MenuItem[] = [
	{ key: "review", label: "Review 3 commits", detail: "abc1234 → def5678", onSelect: () => {} },
	{ key: "compare", label: "Compare with worktree", detail: "abc1234 → worktree", onSelect: () => {} },
	{ key: "label", label: "Create label", onSelect: () => {} },
];

describe("AnchoredMenu", () => {
	test("every row is a plain menu item — no checkable rows", () => {
		const html = render(items);
		expect(html.match(/role="menuitem"/g)).toHaveLength(3);
		expect(html).not.toContain("menuitemcheckbox");
		expect(html).not.toContain("aria-checked");
	});

	test("a detail rides inside its own row, so the item count is the row count", () => {
		const html = render(items);
		const rows = html.match(/<button[^>]*role="menuitem"[\s\S]*?<\/button>/g) ?? [];
		expect(rows).toHaveLength(3);
		expect(rows[0]).toContain("Review 3 commits");
		expect(rows[0]).toContain("abc1234 → def5678");
		// The detail-less row still renders as one row, not as a missing line.
		expect(rows[2]).toContain("Create label");
	});

	test("a refused command stays reachable and names the reason inline", () => {
		const html = render([
			{ key: "review", label: "Review 3 commits", detail: "A turn is running", disabled: true, onSelect: () => {} },
		]);
		expect(html).toContain('aria-disabled="true"');
		expect(html).toContain("A turn is running");
	});
});
