// topBarTitle — the center slot never names a Session it does not render.
// The regression it pins: a Project home keeps the previous Session's document
// published as `staged` (it belongs to the Session being left, for the cache and
// rollback paths), and reading `document.status.name` unconditionally put that
// name in the bar and the tab title.

import { describe, expect, test } from "vitest";
import type { Document } from "../../../../src/core/index.ts";
import { topBarTitle } from "./topBarTitle.ts";

/** An empty mirror state, optionally carrying a name as an attached Session's
 * document would. */
function doc(name = ""): Document {
	return {
		status: {
			leafId: null,
			name,
			model: { provider: "", modelId: "" },
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			stats: {
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: { total: 0 },
				messages: 0,
			},
			contextUsage: null,
			pendingSteer: [],
		},
		entries: {},
	};
}

describe("topBarTitle — the rendered object, never a staged leftover", () => {
	test("an attached Session names the slot", () => {
		expect(topBarTitle({ currentProjectId: "bridge", currentStem: "s1", document: doc("refactor the parser") })).toBe(
			"refactor the parser",
		);
	});

	test("a Project home names the Project, not the Session staged underneath", () => {
		expect(topBarTitle({ currentProjectId: "bridge", currentStem: null, document: doc("refactor the parser") })).toBe(
			"bridge",
		);
	});

	test("the Launcher carries no object — the bar falls back to the app name", () => {
		expect(topBarTitle({ currentProjectId: null, currentStem: null, document: doc("refactor the parser") })).toBe("");
	});
});
