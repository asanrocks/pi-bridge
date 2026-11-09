// TopBar — the center slot's affordance at the markup level
// (renderToStaticMarkup, no store): a Session name is a control because it
// renames, while a Project id on its home (and the app name on the Launcher) is
// text, because there is nothing there to rename.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { TopBar } from "./TopBar.tsx";

type Props = Parameters<typeof TopBar>[0];

function render(overrides: Partial<Props> = {}): string {
	return renderToStaticMarkup(
		createElement(TopBar, {
			name: "refactor the parser",
			connection: { kind: "connected" },
			showSidebarToggle: false,
			onSidebarToggle: () => {},
			waitingCount: 0,
			waitingNewCount: 0,
			showHistoryToggle: true,
			onHistory: () => {},
			canRename: true,
			onRename: async () => {},
			onRetry: () => {},
			...overrides,
		}),
	);
}

describe("TopBar — the center slot", () => {
	test("a Session name is the rename control", () => {
		expect(render()).toContain(">refactor the parser</button>");
	});

	test("a Project home names the Project as text, with no rename affordance", () => {
		const html = render({ name: "bridge", canRename: false });
		expect(html).toContain(">bridge</div>");
		expect(html).not.toContain(">bridge</button>");
	});

	test("the Launcher falls back to the app name", () => {
		expect(render({ name: "", canRename: false })).toContain(">pi-bridge</div>");
	});
});
