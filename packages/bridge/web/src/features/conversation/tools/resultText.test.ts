// resultText parsing — pins each status-line and truncation-footer format
// the pi tools append to result text (bash.ts appendStatus/formatOutput,
// read.ts continuation notices). Pure functions; no store, no DOM.

import { describe, expect, test } from "vitest";
import { normalizeEditArgs } from "./args.ts";
import {
	bashStatusChip,
	bashTailPreview,
	errorPreviewLine,
	headPreview,
	parseBashResult,
	parseReadNotice,
	truncationWarnings,
} from "./resultText.ts";

describe("parseBashResult", () => {
	test("plain output passes through", () => {
		const r = parseBashResult("line 1\nline 2");
		expect(r.output).toBe("line 1\nline 2");
		expect(r.status).toBeNull();
		expect(r.notice).toBeNull();
		expect(r.fullPath).toBeNull();
	});

	test("exit-code status line is stripped into a status", () => {
		const r = parseBashResult("boom\n\nCommand exited with code 127");
		expect(r.output).toBe("boom");
		expect(r.status).toEqual({ kind: "exit", code: 127 });
	});

	test("timeout status line", () => {
		const r = parseBashResult("partial\n\nCommand timed out after 30 seconds");
		expect(r.output).toBe("partial");
		expect(r.status).toEqual({ kind: "timeout", secs: 30 });
	});

	test("aborted status with no output", () => {
		const r = parseBashResult("Command aborted");
		expect(r.output).toBe("");
		expect(r.status).toEqual({ kind: "aborted" });
	});

	test("truncation footer (lines variant) yields notice + path", () => {
		const r = parseBashResult("tail lines\n\n[Showing lines 41-60 of 100. Full output: /tmp/pi-bash123.log]");
		expect(r.output).toBe("tail lines");
		expect(r.notice).toBe("Showing lines 41-60 of 100");
		expect(r.fullPath).toBe("/tmp/pi-bash123.log");
		expect(r.status).toBeNull();
	});

	test("truncation footer (bytes-limit variant)", () => {
		const r = parseBashResult("tail\n\n[Showing lines 41-60 of 100 (30KB limit). Full output: /tmp/pi-bash1.log]");
		expect(r.notice).toBe("Showing lines 41-60 of 100 (30KB limit)");
	});

	test("truncation footer (partial last line variant)", () => {
		const r = parseBashResult("tail\n\n[Showing last 2KB of line 60 (line is 5KB). Full output: /tmp/pi-bash1.log]");
		expect(r.notice).toBe("Showing last 2KB of line 60 (line is 5KB)");
		expect(r.fullPath).toBe("/tmp/pi-bash1.log");
	});

	test("output + footer + status all strip in order", () => {
		const r = parseBashResult(
			"out\n\n[Showing lines 1-20 of 5000. Full output: /tmp/pi-bash9.log]\n\nCommand exited with code 1",
		);
		expect(r.output).toBe("out");
		expect(r.notice).toBe("Showing lines 1-20 of 5000");
		expect(r.fullPath).toBe("/tmp/pi-bash9.log");
		expect(r.status).toEqual({ kind: "exit", code: 1 });
	});

	test("status-line lookalike mid-output is left alone", () => {
		// Only the LAST paragraph is considered; an embedded lookalike is
		// indistinguishable from real output and stays in it.
		const r = parseBashResult("Command exited with code 0\n\nreal tail");
		expect(r.output).toBe("Command exited with code 0\n\nreal tail");
		expect(r.status).toBeNull();
	});
});

describe("bashStatusChip", () => {
	test("exit code chip", () => {
		expect(bashStatusChip({ kind: "exit", code: 2 })).toEqual({ text: "exit 2", tone: "error" });
	});

	test("timeout chip", () => {
		expect(bashStatusChip({ kind: "timeout", secs: 10 })).toEqual({
			text: "timed out after 10s",
			tone: "error",
		});
	});

	test("aborted chip", () => {
		expect(bashStatusChip({ kind: "aborted" })).toEqual({ text: "aborted", tone: "error" });
	});
});

describe("normalizeEditArgs — malformed model output (TUI parity)", () => {
	test("well-formed edits array passes through", () => {
		expect(normalizeEditArgs({ path: "a.ts", edits: [{ oldText: "a", newText: "b" }] })).toEqual([
			{ oldText: "a", newText: "b" },
		]);
	});

	test("edits as JSON string parses", () => {
		expect(normalizeEditArgs({ edits: JSON.stringify([{ oldText: "a", newText: "b" }]) })).toEqual([
			{ oldText: "a", newText: "b" },
		]);
	});

	test("single JSON-string edit object wraps into an array", () => {
		expect(normalizeEditArgs({ edits: JSON.stringify({ oldText: "a", newText: "b" }) })).toEqual([
			{ oldText: "a", newText: "b" },
		]);
	});

	test("single edit object (not array) wraps", () => {
		expect(normalizeEditArgs({ edits: { oldText: "a", newText: "b" } })).toEqual([{ oldText: "a", newText: "b" }]);
	});

	test("legacy top-level oldText/newText becomes one edit", () => {
		expect(normalizeEditArgs({ path: "a.ts", oldText: "a", newText: "b" })).toEqual([{ oldText: "a", newText: "b" }]);
	});

	test("legacy pair appends to a valid edits array", () => {
		expect(
			normalizeEditArgs({
				edits: [{ oldText: "a", newText: "b" }],
				oldText: "c",
				newText: "d",
			}),
		).toEqual([
			{ oldText: "a", newText: "b" },
			{ oldText: "c", newText: "d" },
		]);
	});

	test("malformed JSON string and empty args yield null", () => {
		expect(normalizeEditArgs({ edits: "{not json" })).toBeNull();
		expect(normalizeEditArgs({})).toBeNull();
		expect(normalizeEditArgs(null)).toBeNull();
	});
});

describe("bashTailPreview", () => {
	test("short output shows all lines, no hint", () => {
		const r = bashTailPreview("a\nb", 5);
		expect(r.lines).toEqual(["a", "b"]);
		expect(r.skipped).toBe(0);
	});

	test("long output shows the tail with an earlier-lines count", () => {
		const r = bashTailPreview("1\n2\n3\n4\n5\n6\n7", 5);
		expect(r.lines).toEqual(["3", "4", "5", "6", "7"]);
		expect(r.skipped).toBe(2);
	});

	test("exactly max lines shows all, no hint", () => {
		const r = bashTailPreview("1\n2\n3\n4\n5", 5);
		expect(r.skipped).toBe(0);
		expect(r.lines).toHaveLength(5);
	});
});

describe("headPreview", () => {
	test("short output shows all lines, no hint", () => {
		const r = headPreview("a\nb", 5);
		expect(r.lines).toEqual(["a", "b"]);
		expect(r.skipped).toBe(0);
	});

	test("long output shows the head with a more-lines count", () => {
		const r = headPreview("1\n2\n3\n4\n5\n6\n7", 5);
		expect(r.lines).toEqual(["1", "2", "3", "4", "5"]);
		expect(r.skipped).toBe(2);
	});
});

describe("truncationWarnings — search-tool details", () => {
	test("grep match limit and byte limit", () => {
		expect(truncationWarnings({ matchLimitReached: 100, truncation: { truncated: true, maxBytes: 30720 } })).toEqual([
			"100 matches limit",
			"30KB limit",
		]);
	});

	test("grep line truncation", () => {
		expect(truncationWarnings({ linesTruncated: true })).toEqual(["some lines truncated"]);
	});

	test("find result limit and ls entry limit", () => {
		expect(truncationWarnings({ resultLimitReached: 1000 })).toEqual(["1000 result limit"]);
		expect(truncationWarnings({ entryLimitReached: 500 })).toEqual(["500 entry limit"]);
	});

	test("untruncated details produce no warnings", () => {
		expect(truncationWarnings({ truncation: { truncated: false } })).toEqual([]);
		expect(truncationWarnings(null)).toEqual([]);
		expect(truncationWarnings(undefined)).toEqual([]);
	});
});

describe("errorPreviewLine", () => {
	test("first line only", () => {
		expect(errorPreviewLine("line one\nline two")).toBe("line one");
	});

	test("long first line truncates", () => {
		const r = errorPreviewLine(`${"x".repeat(300)}\ntail`);
		expect(r.length).toBe(200);
		expect(r.endsWith("...")).toBe(true);
	});

	test("empty text yields empty line", () => {
		expect(errorPreviewLine("")).toBe("");
	});
});

describe("parseReadNotice", () => {
	test("content without notice passes through", () => {
		const r = parseReadNotice("alpha\n\nbeta");
		expect(r.content).toBe("alpha\n\nbeta");
		expect(r.notice).toBeNull();
	});

	test("offset continuation notice is stripped", () => {
		const r = parseReadNotice("file body\n\n[Showing lines 1-80 of 1200. Use offset=81 to continue.]");
		expect(r.content).toBe("file body");
		expect(r.notice).toBe("[Showing lines 1-80 of 1200. Use offset=81 to continue.]");
	});

	test("bytes-limit continuation notice", () => {
		const r = parseReadNotice("body\n\n[Showing lines 1-80 of 1200 (30KB limit). Use offset=81 to continue.]");
		expect(r.notice).toBe("[Showing lines 1-80 of 1200 (30KB limit). Use offset=81 to continue.]");
	});

	test("user-limit continuation notice", () => {
		const r = parseReadNotice("body\n\n[40 more lines in file. Use offset=81 to continue.]");
		expect(r.content).toBe("body");
		expect(r.notice).toBe("[40 more lines in file. Use offset=81 to continue.]");
	});

	test("first-line-exceeds notice (whole-result notice)", () => {
		const r = parseReadNotice("[Line 1 is 45KB, exceeds 30KB limit. Use bash: sed -n '1p' big.txt | head -c 30720]");
		expect(r.content).toBe("");
		expect(r.notice).toBe("[Line 1 is 45KB, exceeds 30KB limit. Use bash: sed -n '1p' big.txt | head -c 30720]");
	});

	test("bracketed paragraph that is not a notice stays in content", () => {
		const r = parseReadNotice("body\n\n[link](https://example.com)");
		expect(r.content).toBe("body\n\n[link](https://example.com)");
		expect(r.notice).toBeNull();
	});
});
