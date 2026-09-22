// ApplyPatchCardBody — SSR tests for the Codex-style apply_patch envelope
// card: per-file section titles and diff lines, the raw-text fallback before
// the envelope streams in (content must never disappear — same gate rule as
// the other card bodies), delete sections (label only), seek-marker notes,
// and the result text under the diff (apply_patch failures cross the wire as
// normal content, not errors, so the body owns their visibility).
//
// SSR runs no effects, so DiffSections renders its plain-text lines — exactly
// the streaming/pre-highlight display path under test.
//
// Lives under web/ (not test/suite/) because it imports .tsx components;
// root tsgo has no --jsx, so it is type-checked by check:bridge-web instead.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { ToolActionVM } from "../../../../../src/viewmodel/index.ts";
import type { ActionDetailsProps } from "./args.ts";

vi.mock("../../../render/CodeSnippet.tsx", () => ({
	CodeSnippet: ({ code }: { code: string }) => createElement("pre", null, code),
}));

vi.mock("../../../render/shiki.ts", () => ({
	highlightTokens: () => Promise.resolve({ bg: "transparent", fg: "inherit", lines: [] }),
}));

const { ApplyPatchCardBody } = await import("./ApplyPatchCardBody.tsx");

const action = {} as ToolActionVM;

function render(args: ActionDetailsProps["args"], resultText: string | null = null): string {
	return renderToStaticMarkup(createElement(ApplyPatchCardBody, { action, args, resultText, resultImages: [] }));
}

const ENVELOPE = `*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
@@ def greet():
 context
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch`;

describe("ApplyPatchCardBody", () => {
	test("renders per-file sections: titles, diff lines, seek notes", () => {
		const html = render({ input: ENVELOPE });
		expect(html).toContain("Add hello.txt");
		expect(html).toContain("Update src/app.py");
		expect(html).toContain("Delete obsolete.txt");
		// Added content of the Add section.
		expect(html).toContain("Hello world");
		// Old/new lines of the Update chunk render as a word-diffed single-line
		// pair (unchanged parts as plain spans, changed parts highlighted).
		expect(html).toContain(">Hi</span>");
		expect(html).toContain(">Hello, world!</span>");
		expect(html).toContain("editDiffInlineChanged");
		expect(html).toContain("def greet():");
		expect(html).toContain("context");
	});

	test("section labels open the file viewer (button + tooltip)", () => {
		const html = render({ input: ENVELOPE });
		// Every titled section is a button whose tooltip carries the raw
		// envelope path (cwd-relative display stays in the visible label).
		expect(html).toContain('title="Open file: hello.txt"');
		expect(html).toContain('title="Open file: src/app.py"');
		expect(html).toContain('title="Open file: obsolete.txt"');
		// Move target wins for moved updates.
		const moved = render({
			input: "*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n-a\n+b\n*** End Patch",
		});
		expect(moved).toContain('title="Open file: b.ts"');
	});

	test("delete sections render the label only — no invented content", () => {
		const html = render({ input: "*** Begin Patch\n*** Delete File: gone.ts\n*** End Patch" });
		expect(html).toContain("Delete gone.ts");
		// A delete carries no old content in the envelope — nothing renders
		// under the label (no diff lines exist to render).
		expect(html).not.toContain("---");
	});

	test("folds Move to into the update title", () => {
		const html = render({
			input: "*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n-a\n+b\n*** End Patch",
		});
		expect(html).toContain("Update a.ts → b.ts");
		expect(html).toContain("b"); // add line renders
	});

	test("raw-text fallback keeps streaming content visible before the envelope", () => {
		const html = render({ input: "I will apply a patch now" });
		expect(html).toContain("I will apply a patch now");
	});

	test("mid-stream envelope renders the sections that have arrived", () => {
		const html = render({ input: "*** Begin Patch\n*** Add File: new.ts\n+first" });
		expect(html).toContain("Add new.ts");
		expect(html).toContain("first");
	});

	test("renders the result text under the diff (failures are non-error content)", () => {
		const html = render({ input: ENVELOPE }, "apply_patch partially failed.\nFailed:\n- a.ts (update): not found");
		expect(html).toContain("apply_patch partially failed.");
	});

	test("renders nothing with no input argument", () => {
		expect(render({})).toBe("");
		expect(render(null)).toBe("");
	});
});
