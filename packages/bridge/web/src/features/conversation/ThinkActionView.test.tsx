// ThinkActionView — the header row renders the thinking's first line as
// Markdown (streamdown) on the preview class and stays visible in both states,
// so the full-width row is always the collapse target; the expanded body adds
// the full text below. redacted/empty/lazy states are the static label. The lazy
// state is also what decides whether a thinking pull is registered: a settled
// row must not enqueue (nor, in the component, subscribe to pullTick).
//
// Lives under web/ (not test/suite/) because it imports .tsx components;
// root tsc has no --jsx, so it is type-checked by check:bridge-web instead.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import styles from "./actions.module.css";

const harness = vi.hoisted(() => ({
	state: undefined as unknown,
	previews: [] as { text: string; className?: string }[],
}));

vi.mock("../../infra/state/store.tsx", () => ({
	useStore: (selector: (s: unknown) => unknown) => selector(harness.state),
}));

vi.mock("../viewer/AppMarkdown.tsx", () => ({
	AppMarkdown: ({ text, className }: { text: string; className?: string }) => {
		harness.previews.push({ text, className });
		return createElement("span", { className, "data-preview": "1" }, text);
	},
}));

const { drainPullQueue } = await import("../../infra/net/pullQueue.ts");
const { ThinkActionView } = await import("./ThinkActionView.tsx");

/** One message entry holding a single thinking block, plus the store fields
 * the view selects. `thinking: null` is the lazy (un-pulled) state. */
function setState(thinking: string | null, opts: { expanded?: boolean } = {}): void {
	harness.state = {
		document: { entries: { a1: { kind: "message", id: "a1", content: [{ type: "thinking", thinking }] } } },
		expandedActions: new Set(opts.expanded ? ["a1:b0"] : []),
		pullTick: 7,
	};
}

function render(opts: { redacted?: boolean } = {}): string {
	harness.previews = [];
	return renderToStaticMarkup(
		createElement(ThinkActionView, {
			entryId: "a1",
			blockIndex: 0,
			isProvisional: false,
			redacted: opts.redacted ?? false,
			onToggleAction: () => {},
		}),
	);
}

beforeEach(() => {
	drainPullQueue();
});

describe("ThinkActionView — collapsed preview", () => {
	test("renders the first line as Markdown on the preview class", () => {
		setState("first line **bold**\nsecond line\nthird line");
		const html = render();

		expect(harness.previews).toEqual([{ text: "first line **bold**", className: styles.thinkPreview }]);
		expect(html).toContain(`class="${styles.thinkPreview}"`);
		expect(html).toContain("Expand thinking");
		// The preview is capped at line 1 — lines 2..n do not reach the DOM,
		// which is what keeps a collapsed row from re-rendering as it grows.
		expect(html).not.toContain("second line");
	});

	test("expanded keeps the first-line header preview and adds the unclamped full text", () => {
		setState("first line\nsecond line", { expanded: true });
		const html = render();

		// Header preview first, then the full document: the header row stays
		// the full-width collapse target.
		expect(harness.previews).toEqual([
			{ text: "first line", className: styles.thinkPreview },
			{ text: "first line\nsecond line", className: undefined },
		]);
		expect(html).toContain(styles.thinkPreview);
		expect(html).toContain("Collapse thinking");
	});

	test("redacted and empty thinking are static labels with no preview", () => {
		setState(null, { expanded: true });
		expect(render({ redacted: true })).toContain("(redacted)");
		expect(harness.previews).toEqual([]);

		setState("", { expanded: true });
		expect(render()).toContain("think");
		expect(harness.previews).toEqual([]);
	});

	test("registers the thinking pull only while the lazy field is null", () => {
		setState(null);
		render();
		expect(drainPullQueue()).toEqual([{ entryId: "a1", fieldPath: "/entries/a1/content/0/thinking" }]);

		setState("first line");
		render();
		expect(drainPullQueue()).toEqual([]);

		setState(null);
		render({ redacted: true });
		expect(drainPullQueue()).toEqual([]);
	});
});
