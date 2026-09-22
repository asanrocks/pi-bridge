// ============================================================================
// apply-patch unit tests — the display parser (envelope sections, streaming
// tolerance, heredoc unwrap), the argument extractor, and the summary /
// header / kind projections for `apply_patch` tool calls.
// Pure tests — no mirror, no WebSocket, no transport.
// ============================================================================

import { describe, expect, it } from "vitest";
import {
	applyPatchInput,
	extractApplyPatchPaths,
	kindForTool,
	makeActionHeader,
	makeActionSummary,
	parseApplyPatch,
} from "../../src/viewmodel/index.ts";

const FULL_ENVELOPE = `*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
@@ def greet():
 context
-print("Hi")
+print("Hello, world!")
*** Update File: src/other.ts
*** Move to: src/moved.ts
@@ class Foo:
-old
+new
*** Delete File: obsolete.txt
*** End Patch`;

describe("parseApplyPatch — full envelopes", () => {
	it("parses add, update (with seek markers), move, and delete sections", () => {
		const parsed = parseApplyPatch(FULL_ENVELOPE);
		expect(parsed.ok).toBe(true);
		expect(parsed.complete).toBe(true);
		expect(parsed.sections).toHaveLength(4);

		const [add, update, moved, del] = parsed.sections;
		expect(add).toEqual({ type: "add", filePath: "hello.txt", content: "Hello world" });
		expect(update).toEqual({
			type: "update",
			filePath: "src/app.py",
			movePath: null,
			chunks: [
				{ contexts: ["def greet():"], oldText: 'context\nprint("Hi")', newText: 'context\nprint("Hello, world!")' },
			],
		});
		expect(moved).toEqual({
			type: "update",
			filePath: "src/other.ts",
			movePath: "src/moved.ts",
			chunks: [{ contexts: ["class Foo:"], oldText: "old", newText: "new" }],
		});
		expect(del).toEqual({ type: "delete", filePath: "obsolete.txt" });
	});

	it("splits multiple chunks of one update section and skips bare @@ markers", () => {
		const parsed = parseApplyPatch(`*** Begin Patch
*** Update File: a.ts
@@
 first
-x
+y
@@ second locator
 last
-p
+q
*** End Patch`);
		expect(parsed.sections).toHaveLength(1);
		const first = parsed.sections[0];
		expect(first?.type).toBe("update");
		expect(first?.type === "update" && first.chunks).toEqual([
			{ contexts: [], oldText: "first\nx", newText: "first\ny" },
			{ contexts: ["second locator"], oldText: "last\np", newText: "last\nq" },
		]);
	});

	it("terminates a chunk at *** End of File without ending the section list", () => {
		const parsed = parseApplyPatch(`*** Begin Patch
*** Update File: a.ts
@@ ctx
-a
+b
*** End of File
*** Delete File: b.ts
*** End Patch`);
		expect(parsed.complete).toBe(true);
		expect(parsed.sections).toEqual([
			{
				type: "update",
				filePath: "a.ts",
				movePath: null,
				chunks: [{ contexts: ["ctx"], oldText: "a", newText: "b" }],
			},
			{ type: "delete", filePath: "b.ts" },
		]);
	});

	it("unwraps a heredoc-wrapped envelope and normalizes CRLF", () => {
		const wrapped = `cat <<'EOF'\r\n${FULL_ENVELOPE.replace(/\n/g, "\r\n")}\r\nEOF`;
		const parsed = parseApplyPatch(wrapped);
		expect(parsed.ok).toBe(true);
		expect(parsed.complete).toBe(true);
		expect(parsed.sections).toHaveLength(4);
	});
});

describe("parseApplyPatch — streaming and malformed input", () => {
	it("is not ok before the envelope begins", () => {
		const parsed = parseApplyPatch("I will now patch the files:\n*** Begin Patch");
		expect(parsed.ok).toBe(false);
		expect(parsed.complete).toBe(false);
	});

	it("returns the header-only update section while hunks stream", () => {
		const parsed = parseApplyPatch("*** Begin Patch\n*** Update File: src/app.py");
		expect(parsed.ok).toBe(true);
		expect(parsed.complete).toBe(false);
		expect(parsed.sections).toEqual([{ type: "update", filePath: "src/app.py", movePath: null, chunks: [] }]);
	});

	it("keeps a partially streamed trailing chunk", () => {
		const parsed = parseApplyPatch(`*** Begin Patch
*** Update File: a.ts
@@ ctx
-a
+b
 con`);
		expect(parsed.complete).toBe(false);
		const section = parsed.sections[0];
		expect(section?.type).toBe("update");
		expect(section?.type === "update" && section.chunks[0]).toEqual({
			contexts: ["ctx"],
			oldText: "a\ncon",
			newText: "b\ncon",
		});
	});

	it("keeps a partially streamed add section", () => {
		const parsed = parseApplyPatch("*** Begin Patch\n*** Add File: new.ts\n+line one\n+line tw");
		expect(parsed.ok).toBe(true);
		expect(parsed.sections[0]).toEqual({ type: "add", filePath: "new.ts", content: "line one\nline tw" });
	});

	it("skips non-conforming body lines instead of rejecting", () => {
		const parsed = parseApplyPatch(`*** Begin Patch
*** Update File: a.ts
@@ ctx
garbage line
-a
+b
*** End Patch`);
		expect(parsed.ok).toBe(true);
		const section = parsed.sections[0];
		expect(section?.type).toBe("update");
		expect(section?.type === "update" && section.chunks[0]).toEqual({
			contexts: ["ctx"],
			oldText: "a",
			newText: "b",
		});
	});
});

describe("applyPatchInput", () => {
	it("reads the normalized { input } shape pi-ai records for grammar tools", () => {
		expect(applyPatchInput({ input: "*** Begin Patch" })).toBe("*** Begin Patch");
	});

	it("accepts a raw string argument defensively", () => {
		expect(applyPatchInput("*** Begin Patch")).toBe("*** Begin Patch");
	});

	it("returns null for anything else", () => {
		expect(applyPatchInput(null)).toBeNull();
		expect(applyPatchInput({})).toBeNull();
		expect(applyPatchInput({ input: 42 })).toBeNull();
		expect(applyPatchInput([{ input: "x" }])).toBeNull();
	});
});

describe("extractApplyPatchPaths", () => {
	it("lists Add/Update/Delete paths but not Move targets, on partial envelopes too", () => {
		expect(extractApplyPatchPaths(FULL_ENVELOPE)).toEqual([
			"hello.txt",
			"src/app.py",
			"src/other.ts",
			"obsolete.txt",
		]);
		expect(extractApplyPatchPaths("*** Begin Patch\n*** Update File: src/a.ts")).toEqual(["src/a.ts"]);
	});

	it("returns empty for non-envelopes", () => {
		expect(extractApplyPatchPaths("just text")).toEqual([]);
	});
});

describe("apply_patch projection — summary, header, kind", () => {
	it("summarizes as patch: <file> / patch: <file> +N", () => {
		expect(makeActionSummary("apply_patch", { input: FULL_ENVELOPE })).toBe("patch: hello.txt +3");
		const single = "*** Begin Patch\n*** Update File: src/app.py\n-a\n+b\n*** End Patch";
		expect(makeActionSummary("apply_patch", { input: single })).toBe("patch: app.py");
	});

	it("falls back to the bare name before any path streams", () => {
		expect(makeActionSummary("apply_patch", { input: "*** Begin Patch" })).toBe("apply_patch");
		expect(makeActionSummary("apply_patch", null)).toBe("apply_patch");
	});

	it("headers with all cwd-relative paths, and raw string args work", () => {
		expect(makeActionHeader("apply_patch", { input: FULL_ENVELOPE }, "/repo")).toBe(
			"hello.txt, src/app.py, src/other.ts, obsolete.txt",
		);
		expect(makeActionHeader("apply_patch", "/abs/x/a.ts", "/repo")).toBeNull();
		const abs = "*** Begin Patch\n*** Update File: /repo/src/a.ts\n-a\n+b\n*** End Patch";
		expect(makeActionHeader("apply_patch", abs, "/repo")).toBe("src/a.ts");
		expect(makeActionHeader("apply_patch", { input: "*** Begin Patch" })).toBeNull();
	});

	it("maps to the edit kind (mutate hue)", () => {
		expect(kindForTool("apply_patch")).toBe("edit");
	});
});
