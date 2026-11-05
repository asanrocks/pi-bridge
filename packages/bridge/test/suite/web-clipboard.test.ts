// The copy confirmation's live-region mechanism (web/src/infra/lib/clipboard.ts):
// one polite region per page, announced on a successful write, cleared after the
// feedback window so a second copy announces again — a live region announces
// only changes, so the clear is what makes the repeat audible. The suite runs in
// Node, so the few DOM globals the mechanism touches are stubbed with exactly
// what it uses; the assertions are about the region's lifecycle, not the DOM.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COPIED_FEEDBACK_MS, copyToClipboard } from "../../web/src/infra/lib/clipboard.ts";

/** The one element the mechanism builds: attributes, inline styles, text. */
class Region {
	readonly attributes = new Map<string, string>();
	readonly style: Record<string, string> = {};
	textContent = "";
	setAttribute(name: string, value: string) {
		this.attributes.set(name, value);
	}
}

const regions: Region[] = [];
const appended: Region[] = [];

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("document", {
		createElement: () => {
			const region = new Region();
			regions.push(region);
			return region;
		},
		body: { append: (region: Region) => appended.push(region) },
	});
	vi.stubGlobal("window", {
		// Routed through globalThis so fake timers control the clear.
		setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
		// A secure context, so the failure path stays off the guidance dialog.
		isSecureContext: true,
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("copy announcement", () => {
	it("announces each successful copy through one polite region, cleared after the feedback window", async () => {
		// ~2s, matching Streamdown's own copy confirmation.
		expect(COPIED_FEEDBACK_MS).toBe(2000);
		vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });

		expect(await copyToClipboard("hello")).toBe(true);
		expect(regions).toHaveLength(1);
		expect(appended).toEqual([regions[0]]);
		expect(regions[0]!.attributes.get("aria-live")).toBe("polite");
		expect(regions[0]!.textContent).toBe("Copied to clipboard");

		// The clear is what lets the next copy announce again.
		vi.advanceTimersByTime(COPIED_FEEDBACK_MS);
		expect(regions[0]!.textContent).toBe("");

		expect(await copyToClipboard("again")).toBe(true);
		expect(regions).toHaveLength(1); // one region, reused
		expect(regions[0]!.textContent).toBe("Copied to clipboard");
		vi.advanceTimersByTime(COPIED_FEEDBACK_MS);
		expect(regions[0]!.textContent).toBe("");
	});

	it("reports a failed write without announcing", async () => {
		vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
		const before = regions.length;
		expect(await copyToClipboard("denied")).toBe(false);
		expect(regions).toHaveLength(before);
	});
});
