// Regression: tool card bodies must render streaming argument content as it
// arrives, even before the "annotation" argument (path/command) is streamed.
//
// Root cause: every card body opened with `if (!path) return null` (or
// `if (!command)`), gating the ENTIRE body on one argument key. When the
// LLM streamed the bulk content before that key — e.g. a `write` whose
// `content` streamed for seconds before `path` arrived — the card rendered
// nothing until the key showed up near completion, so the content appeared
// "all at once" instead of streaming. The TUI, which renders streaming
// arguments directly, did not have this gate.
//
// These tests render the card bodies via SSR with mid-stream args (bulk
// content present, annotation key absent) and assert the content is visible.
// SSR doesn't run effects, so CodeSnippet renders its raw-code fallback —
// which is exactly the streaming display path under test.
//
// Lives under web/ (not test/suite/) because it imports .tsx components;
// root tsgo has no --jsx, so it is type-checked by check:bridge-web instead.

import type { ComponentType } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { ToolActionStepVM } from "../../../../../src/viewmodel/index.ts";
import type { ActionDetailsProps } from "./args.ts";

// Stub CodeSnippet: isolates the gate logic and avoids loading shiki/streamdown
// in the node test env. The stub mirrors the real SSR path (raw code text).
vi.mock("../../../render/CodeSnippet.ts", () => ({
	CodeSnippet: ({ code }: { code: string }) => createElement("pre", null, code),
}));

// Stub Markdown for the same reason (streamdown). The card bodies render it
// for .md content when the markdown toggle is on; tests assert the toggle
// hand-off, not streamdown output.
vi.mock("../../../render/markdown.tsx", () => ({
	Markdown: ({ text }: { text: string }) => createElement("div", { "data-md-stub": "" }, text),
}));

// Stub the Shiki singleton for BashIdentity (same reason as CodeSnippet —
// keep the node test env free of the highlighter bundle). SSR runs no
// effects, so the stub is never even awaited.
vi.mock("../../../render/shiki.ts", () => ({
	highlightTokens: () => Promise.resolve({ bg: "transparent", fg: "inherit", lines: [] }),
}));

const { WriteCardBody } = await import("./WriteCardBody.tsx");
const { EditCardBody } = await import("./EditCardBody.tsx");
const { ReadCardBody } = await import("./ReadCardBody.tsx");
const { BashCardBody } = await import("./BashCardBody.tsx");
const { FallbackCardBody } = await import("./FallbackCardBody.tsx");
const { CardStatusLine, CardIdentity, CardError, CardControls } = await import("./CardSkeleton.tsx");
const { BashIdentity } = await import("./BashIdentity.tsx");
const { SearchResultBody } = await import("./SearchResultBody.tsx");
const { UserBashView } = await import("../UserBashView.tsx");

// Card bodies only read `step` opportunistically (FallbackCardBody); the
// per-tool bodies under test ignore it. A bare cast satisfies the prop type.
const step = {} as ToolActionStepVM;

function render(
	Body: ComponentType<ActionDetailsProps>,
	args: ActionDetailsProps["args"],
	resultText: string | null = null,
	resultImages: ActionDetailsProps["resultImages"] = [],
): string {
	return renderToStaticMarkup(createElement(Body, { step, args, resultText, resultImages }));
}

// The command moved out of the bash body: it renders in the skeleton's
// identity line (full command, all lines), so mid-stream command visibility
// is covered by the makeActionIdentity tests in test/suite/viewmodel-unit.
// The body is output-only.
describe("tool card streaming — content visible before annotation key", () => {
	test("WriteCardBody renders streaming content before path arrives", () => {
		// Mid-stream: the model emitted `content` (streaming) but `path` has
		// not arrived yet. Previously `if (!path) return null` hid this.
		const html = render(WriteCardBody, { content: "Spring is the season of renewal", path: undefined });
		expect(html).toContain("Spring is the season of renewal");
		expect(html).not.toContain("essay.txt"); // path not yet streamed
	});

	test("WriteCardBody keeps content once path arrives", () => {
		// The path identifier now lives in the step header (ToolActionStepView),
		// not the details body — the body renders content only.
		const html = render(WriteCardBody, { content: "Spring", path: "essay.txt" });
		expect(html).toContain("Spring");
		expect(html).not.toContain("essay.txt");
	});

	test("WriteCardBody renders nothing before any argument streams", () => {
		const html = render(WriteCardBody, {});
		expect(html).toBe("");
	});

	test("EditCardBody renders streaming edits before path arrives", () => {
		const html = render(EditCardBody, { edits: [{ oldText: "foo", newText: "barbar" }], path: undefined });
		expect(html).toContain("foo");
		expect(html).toContain("barbar");
	});

	test("BashCardBody renders streaming output as it arrives", () => {
		const html = render(BashCardBody, { command: "wc -w ./essay.txt" }, "1234 essay.txt");
		expect(html).toContain("1234 essay.txt");
	});

	test("BashCardBody renders nothing before the result streams", () => {
		const html = render(BashCardBody, { command: "wc -w ./essay.txt" });
		expect(html).toBe("");
	});

	test("BashCardBody strips the status line into nothing and keeps the output", () => {
		// The status line renders as a top-bar chip (ToolActionStepView);
		// the body shows the bare output.
		const html = render(BashCardBody, { command: "false" }, "boom\n\nCommand exited with code 1");
		expect(html).toContain("boom");
		expect(html).not.toContain("Command exited");
	});

	test("BashCardBody renders a truncation notice with the full-output path", () => {
		const html = render(
			BashCardBody,
			{ command: "yes" },
			"tail\n\n[Showing lines 41-60 of 100. Full output: /tmp/pi-bash1.log]",
		);
		expect(html).toContain("truncated — Showing lines 41-60 of 100");
		expect(html).toContain("full output");
		expect(html).not.toContain("Full output:");
	});

	// Bash three-state content: expanded shows "... N earlier lines" + the
	// output tail (line-count cap, no scroll window); "show all" (store
	// uncappedDetails — not flippable under SSR's getInitialState snapshot)
	// renders the whole output. The tail/head slicing itself is pinned in
	// resultText.test.ts (bashTailPreview).
	test("BashCardBody renders the tail with an earlier-lines hint for long output", () => {
		const lines = Array.from({ length: 25 }, (_, i) => `line-${i + 1}`);
		const html = render(BashCardBody, { command: "seq 25" }, lines.join("\n"));
		expect(html).toContain("… 5 earlier lines");
		expect(html).toContain("line-25");
		expect(html).not.toContain("line-1<");
		expect(html).not.toContain("line-5<");
	});

	test("BashCardBody renders short output in full, no hint", () => {
		const html = render(BashCardBody, { command: "echo" }, "line-1\nline-2");
		expect(html).toContain("line-1");
		expect(html).toContain("line-2");
		expect(html).not.toContain("earlier line");
	});

	test("ReadCardBody strips the continuation notice into a warning strip", () => {
		const html = render(
			ReadCardBody,
			{ path: "src/big.ts" },
			"body\n\n[40 more lines in file. Use offset=81 to continue.]",
		);
		expect(html).toContain("body");
		expect(html).toContain("cardNotice");
		expect(html).toContain("Use offset=81");
	});

	test("ReadCardBody renders result text without a path", () => {
		const html = render(ReadCardBody, { path: undefined }, "file contents here");
		expect(html).toContain("file contents here");
	});
});

// Tool results can carry ImageContent blocks. The read body swaps the text
// snippet for the image (the text is then a redundant caption); the fallback
// body appends images after its existing content.
describe("tool card result images", () => {
	const img = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };

	test("ReadCardBody renders the image instead of the caption snippet", () => {
		const html = render(ReadCardBody, { path: "diagram.png" }, "Read image file [image/png]", [img]);
		expect(html).toContain('src="data:image/png;base64,aGVsbG8="');
		expect(html).not.toContain("Read image file");
	});

	test("ReadCardBody keeps the text snippet when there are no images", () => {
		const html = render(ReadCardBody, { path: "notes.txt" }, "plain file contents", []);
		expect(html).toContain("plain file contents");
		expect(html).not.toContain("<img");
	});

	test("FallbackCardBody renders images after the result text", () => {
		const html = render(FallbackCardBody, { query: "x" }, "found 1 match", [img]);
		expect(html).toContain("found 1 match");
		expect(html).toContain('src="data:image/png;base64,aGVsbG8="');
		expect(html.indexOf("found 1 match")).toBeLessThan(html.indexOf("<img"));
	});

	test("FallbackCardBody renders nothing for empty images", () => {
		const html = render(FallbackCardBody, { query: "x" }, "text only", []);
		expect(html).not.toContain("<img");
	});
});

describe("tool card streaming — mid-stream frames", () => {
	// Simulate the wire ordering observed in log.jsonl: `content` streams in
	// growing fragments while `path` is absent, then `path` arrives at the end.
	const frames: Array<{ content: string; path: string | undefined }> = [
		{ content: "Spring", path: undefined },
		{ content: "Spring is the", path: undefined },
		{ content: "Spring is the season of renewal", path: undefined },
		{ content: "Spring is the season of renewal.", path: "essay.txt" },
	];

	test("WriteCardBody shows growing content on every frame", () => {
		for (const { content, path } of frames) {
			const html = render(WriteCardBody, { content, path });
			expect(html).toContain(content);
			// Path is in the band header, not the body — never present here.
			if (path !== undefined) expect(html).not.toContain(path);
		}
	});
});

// Card skeleton — the status line is presentational (props only), so the
// reload/timing rules test under SSR without a store. Light renders once
// execution has started (running/done/error), but the duration text
// renders only when the run was live-witnessed (a start stamp exists). A
// reloaded/resumed run has status done/error on the wire but no start
// stamp (exec-start isn't on the wire), so it renders the light without a
// "Took" duration. The timeout is a call argument (knowable on reload)
// and docks beside the light — not on the command line.
describe("card skeleton status line", () => {
	function renderStatus(
		status: "pending" | "running" | "done" | "error",
		timing: { startedAt: number; endedAt: number | null } | null,
		timeout: number | null = null,
		chips: ReadonlyArray<{ text: string; tone: "error" | "warning" }> = [],
	): string {
		return renderToStaticMarkup(createElement(CardStatusLine, { status, timing, timeout, chips }));
	}

	test("reloaded done run renders light without duration", () => {
		// status done on the wire (isError=false), but no live-witnessed start.
		const html = renderStatus("done", null);
		expect(html).toContain("cardStatusLight");
		expect(html).not.toContain("Took");
		expect(html).not.toContain("Elapsed");
	});

	test("reloaded error run renders red light without duration", () => {
		const html = renderStatus("error", null);
		expect(html).toContain('data-status="error"');
		expect(html).not.toContain("Took");
	});

	test("reloaded run shows timeout beside the light, not on the command line", () => {
		// timeout is a call annotation (args), knowable on reload; duration is
		// not (exec-start absent from the wire).
		const html = renderStatus("done", null, 10);
		expect(html).toContain("timeout 10s");
		expect(html).not.toContain("Took");
	});

	test("running run renders light with live elapsed", () => {
		const html = renderStatus("running", { startedAt: Date.now() - 1000, endedAt: null }, 10);
		expect(html).toContain('data-status="running"');
		expect(html).toContain("Elapsed");
		expect(html).toContain("timeout 10s");
	});

	test("settled run shows Took with the witnessed duration", () => {
		const html = renderStatus("done", { startedAt: 1000, endedAt: 2500 });
		expect(html).toContain("Took 1.5s");
	});

	test("pending run renders no status line", () => {
		const html = renderStatus("pending", null);
		expect(html).toBe("");
	});

	test("status chips render after the duration text", () => {
		const html = renderStatus("error", { startedAt: 1000, endedAt: 2500 }, 10, [{ text: "exit 1", tone: "error" }]);
		expect(html).toContain('data-tone="error"');
		expect(html).toContain("exit 1");
		expect(html).toContain("Took 1.5s");
	});
});

// Card controls — presentational (props only). Copy availability follows
// the payload; wrap/md toggles carry aria-pressed state; the cap toggle
// renders for capped/uncapped details and nothing otherwise.
describe("card controls", () => {
	const defaults: Parameters<typeof CardControls>[0] = {
		copyText: null,
		showWrap: false,
		wrap: true,
		showMarkdown: false,
		markdown: true,
		capped: "none",
		onToggleWrap: () => {},
		onToggleMarkdown: () => {},
		onToggleCap: () => {},
	};

	function renderControls(overrides: Partial<Parameters<typeof CardControls>[0]> = {}): string {
		return renderToStaticMarkup(createElement(CardControls, { ...defaults, ...overrides }));
	}

	test("no payload, no toggles, no cap — renders nothing", () => {
		expect(renderControls()).toBe("");
	});

	test("copy button appears when a payload exists", () => {
		const html = renderControls({ copyText: "file contents" });
		expect(html).toContain("Copy content");
	});

	test("wrap toggle reflects state via aria-pressed", () => {
		const on = renderControls({ showWrap: true, wrap: true });
		expect(on).toContain('aria-pressed="true"');
		const off = renderControls({ showWrap: true, wrap: false });
		expect(off).toContain('aria-pressed="false"');
	});

	test("markdown toggle only for .md-capable cards", () => {
		expect(renderControls({ showMarkdown: true })).toContain(">md<");
		expect(renderControls({ showMarkdown: false })).not.toContain(">md<");
	});

	test("cap toggle renders show-all when capped, collapse when uncapped", () => {
		expect(renderControls({ capped: "capped" })).toContain("show all");
		expect(renderControls({ capped: "uncapped" })).toContain("collapse");
		expect(renderControls({ capped: "none" })).not.toContain("show all");
	});
});

// Write confirmation — the tool's success line renders under the content.
describe("write confirmation", () => {
	test("WriteCardBody shows the result confirmation line", () => {
		const html = render(WriteCardBody, { path: "a.txt", content: "hello" }, "Successfully wrote 5 bytes to a.txt");
		expect(html).toContain("hello");
		expect(html).toContain("Successfully wrote 5 bytes");
	});

	test("no confirmation before the result arrives", () => {
		const html = render(WriteCardBody, { path: "a.txt", content: "hello" });
		expect(html).not.toContain("Successfully");
	});
});

// Edit malformed-arg tolerance — the diff renders what the tool executed
// even when the model emitted edits in a non-schema shape.
describe("edit argument tolerance", () => {
	test("EditCardBody renders a single-edit object (not array)", () => {
		const html = render(EditCardBody, { path: "a.ts", edits: { oldText: "foo", newText: "barbar" } });
		expect(html).toContain("foo");
		expect(html).toContain("barbar");
	});

	test("EditCardBody renders legacy top-level oldText/newText", () => {
		const html = render(EditCardBody, { path: "a.ts", oldText: "foo", newText: "barbar" });
		expect(html).toContain("foo");
		expect(html).toContain("barbar");
	});

	test("EditCardBody renders edits delivered as a JSON string", () => {
		const html = render(EditCardBody, {
			path: "a.ts",
			edits: JSON.stringify([{ oldText: "foo", newText: "barbar" }]),
		});
		expect(html).toContain("barbar");
	});
});

// User bash card — a user-initiated shell run rendered standalone (not a
// tool step). Presentational via the turn object; SSR covers the band,
// status chips, and output.
describe("user bash view", () => {
	function renderUserBash(turn: Record<string, unknown>): string {
		return renderToStaticMarkup(createElement(UserBashView, { turn: turn as never }));
	}

	test("renders prompt, command, chips, and output", () => {
		const html = renderUserBash({
			kind: "userBash",
			entryId: "b1",
			index: 1,
			timestamp: "2024-01-01T00:00:00Z",
			command: "npm test",
			output: "1 passed",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			fullOutputPath: null,
			excludeFromContext: false,
		});
		expect(html).toContain("npm test");
		expect(html).toContain("1 passed");
		expect(html).not.toContain("exit 0"); // success carries no chip
		expect(html).not.toContain('data-status="error"');
	});

	test("failed run shows exit chip and error light", () => {
		const html = renderUserBash({
			kind: "userBash",
			entryId: "b2",
			index: 0,
			timestamp: "2024-01-01T00:00:00Z",
			command: "false",
			output: "",
			exitCode: 1,
			cancelled: false,
			truncated: false,
			fullOutputPath: null,
			excludeFromContext: true,
		});
		expect(html).toContain("exit 1");
		expect(html).toContain("not in context");
		expect(html).toContain('data-status="error"');
	});

	test("long output renders the tail with an earlier-lines hint", () => {
		const lines = Array.from({ length: 23 }, (_, i) => `out-${i + 1}`);
		const html = renderUserBash({
			kind: "userBash",
			entryId: "b4",
			index: 0,
			timestamp: "2024-01-01T00:00:00Z",
			command: "seq 23",
			output: lines.join("\n"),
			exitCode: 0,
			cancelled: false,
			truncated: false,
			fullOutputPath: null,
			excludeFromContext: false,
		});
		expect(html).toContain("… 3 earlier lines");
		expect(html).toContain("out-23");
		expect(html).not.toContain("out-1<");
	});

	test("cancelled run shows cancelled chip", () => {
		const html = renderUserBash({
			kind: "userBash",
			entryId: "b3",
			index: 0,
			timestamp: "2024-01-01T00:00:00Z",
			command: "sleep 100",
			output: "",
			exitCode: null,
			cancelled: true,
			truncated: false,
			fullOutputPath: null,
			excludeFromContext: false,
		});
		expect(html).toContain("cancelled");
	});
});

// Search-tool result body — grep/find/ls render their result text as
// output lines (the identity line carries the call; the old args-only grid
// is gone). Truncation warnings come from the tool_result details object
// (pure logic pinned in resultText.test.ts).
describe("search result body", () => {
	test("renders match lines", () => {
		const step = { toolName: "grep" } as ToolActionStepVM;
		const html = renderToStaticMarkup(
			createElement(SearchResultBody, {
				step,
				args: { pattern: "TODO", path: "src" },
				resultText: "src/a.ts:12:TODO fix\nsrc/b.ts:30:TODO refactor",
				resultImages: [],
			}),
		);
		expect(html).toContain("src/a.ts:12:TODO fix");
		expect(html).toContain("src/b.ts:30:TODO refactor");
	});

	test("renders nothing before the result streams", () => {
		const step = { toolName: "grep" } as ToolActionStepVM;
		const html = renderToStaticMarkup(
			createElement(SearchResultBody, { step, args: { pattern: "TODO" }, resultText: null, resultImages: [] }),
		);
		expect(html).toBe("");
	});
});

// .md content hand-off: the read body renders Markdown prose when the
// toggle is on, source when off. The store default is on; flipping the
// singleton store's flag exercises the off path.
describe("markdown toggle hand-off", () => {
	test("ReadCardBody renders prose for .md result with toggle on", () => {
		const html = render(ReadCardBody, { path: "README.md" }, "# Title\n\nBody");
		expect(html).toContain("data-md-stub");
		expect(html).toContain("# Title");
	});

	// NOTE: the toggle-off branch is not SSR-testable here — zustand's
	// server snapshot reads getInitialState(), so a runtime setState flip
	// is invisible to renderToStaticMarkup. The toggle actions are covered
	// in test/suite/store-unit.test.ts.
	test("non-markdown paths always render source", () => {
		const html = render(ReadCardBody, { path: "notes.txt" }, "plain contents");
		expect(html).not.toContain("data-md-stub");
	});
});

// Identity line and error strip — presentational, props-only.
describe("card skeleton identity and error zones", () => {
	test("identity renders the full-form identifier", () => {
		const html = renderToStaticMarkup(createElement(CardIdentity, { text: "src/viewmodel/index.ts:12-80" }));
		expect(html).toContain("src/viewmodel/index.ts:12-80");
	});

	test("bash identity renders the raw command until tokens arrive (SSR fallback)", () => {
		// SSR runs no effects, so BashIdentity renders its raw-string path —
		// the same display as the pre-highlighting identity line.
		const html = renderToStaticMarkup(createElement(BashIdentity, { command: "npm run check 2>&1", lang: "bash" }));
		expect(html).toContain("npm run check 2&gt;&amp;1");
	});

	test("identity renders nothing without text", () => {
		expect(renderToStaticMarkup(createElement(CardIdentity, { text: null }))).toBe("");
	});

	test("error strip renders the tool error text", () => {
		const html = renderToStaticMarkup(
			createElement(CardError, { text: "Could not edit file: foo.ts. Error code: ENOENT." }),
		);
		expect(html).toContain("Error code: ENOENT");
	});

	test("error strip renders nothing without text", () => {
		expect(renderToStaticMarkup(createElement(CardError, { text: null }))).toBe("");
	});
});
