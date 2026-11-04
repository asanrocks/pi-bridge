// TurnHeader — the ADR 21 compact header, tested at the markup level
// (renderToStaticMarkup, no store): what the header shows at each tier, and the
// two properties that are easy to lose in a refactor — the date is the details
// trigger with a caret, and a reading is not a control.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { TurnHeader, type TurnHeaderProps } from "./TurnHeader.tsx";

const TIMESTAMP = new Date(2026, 10, 3, 14, 5).toISOString();

function render(overrides: Partial<TurnHeaderProps> = {}): string {
	return renderToStaticMarkup(
		createElement(TurnHeader, {
			timestamp: TIMESTAMP,
			density: "wide",
			details: [{ rows: [{ label: "Time", value: "Nov 3, 2026, 14:05" }] }],
			menuItems: [],
			menuLabel: "Turn actions",
			...overrides,
		}),
	);
}

describe("TurnHeader — the visible line", () => {
	test("the date is a disclosure with the precise instant in its name", () => {
		const html = render();
		expect(html).toContain('aria-haspopup="dialog"');
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain("Turn details — ");
	});

	test("an unknown instant keeps the trigger's shape instead of naming a verb", () => {
		const html = render({ timestamp: "" });
		expect(html).toContain('aria-label="Turn details"');
		expect(html).not.toContain("Details<");
	});

	test("no menu trigger when the menu owns nothing", () => {
		expect(render()).not.toContain("Turn actions");
	});

	test("a menu trigger appears as soon as a command needs a home", () => {
		const html = render({ menuItems: [{ key: "edit", label: "Edit message", onSelect: () => {} }] });
		expect(html).toContain('aria-label="Turn actions"');
		expect(html).toContain('aria-haspopup="menu"');
	});

	test("a reading is text: it opens nothing and has no control semantics", () => {
		const html = render({ reading: { text: "17%", title: "Context window used" } });
		expect(html).toContain("17%");
		// The only dialog trigger on an assistant header is the date.
		expect(html.match(/aria-haspopup="dialog"/g)).toHaveLength(1);
	});

	test("the reading sits in the flow, before the right-hand control area", () => {
		const html = render({
			reading: { text: "17%", title: "Context window used" },
			controls: createElement("button", { type: "button" }, "Edit"),
		});
		// A value's position must not move when the tier moves commands around.
		expect(html.indexOf("17%")).toBeLessThan(html.indexOf("Edit"));
	});

	test("the label chip is the direct edit trigger and carries its value", () => {
		const html = render({ label: { entryId: "e1", label: "draft" } });
		expect(html).toContain("#draft");
		expect(html).not.toContain("Create label");
	});

	test("creating a label is a menu command, not a permanent ghost slot", () => {
		const html = render({ label: { entryId: "e1", label: undefined } });
		expect(html).not.toContain("# label");
		expect(html).toContain('aria-label="Turn actions"');
	});

	test("the label is the only field that yields width", () => {
		const html = render({ label: { entryId: "e1", label: "draft" } });
		// The date and the reading are fixed; the chip is the flexible one.
		expect(html).toMatch(/class="[^"]*turnHeaderDate[^"]*"/);
		expect(html).toMatch(/class="[^"]*msgLabel[^"]*"/);
	});
});

describe("TurnHeader — tiers", () => {
	test("the editing badge is state, not a command: it sits outside the revealed group", () => {
		const html = render({
			badge: createElement("span", null, "Editing"),
			controls: createElement("button", { type: "button" }, "Copy"),
		});
		// The commands fade in on hover; a hidden state indicator would be a lie.
		expect(html.indexOf("Editing")).toBeLessThan(html.indexOf("Copy"));
	});

	test("the density reaches the DOM for the stylesheet's fallback rules", () => {
		expect(render({ density: "narrow" })).toContain('data-density="narrow"');
		expect(render({ density: "wide" })).toContain('data-density="wide"');
	});
});
