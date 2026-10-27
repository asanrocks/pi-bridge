// foldLanding — the landing rule for a fold (ADR 0017): the clicked header keeps
// its screen position and the body slides up beneath it. These tests pin the
// three decisions in that rule: a pinned fold scrolls up by the jump, an
// unpinned fold is a no-op, and a clamped collapse never scrolls down.

import { beforeEach, describe, expect, test, vi } from "vitest";
import { withFoldLanding } from "./foldLanding.ts";

/** Fake header: `tops` is the sequence of viewport tops the element reports —
 * the click-time position, then the collapsed position. */
function header(tops: number[], connected = true) {
	let index = 0;
	return {
		isConnected: connected,
		getBoundingClientRect: () => {
			const top = tops[Math.min(index, tops.length - 1)];
			index++;
			return { top } as DOMRect;
		},
	} as unknown as HTMLElement;
}

const scrollBy = vi.fn();

beforeEach(() => {
	scrollBy.mockReset();
	vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
		cb(0);
		return 0;
	});
	vi.stubGlobal("window", { scrollBy });
});

describe("withFoldLanding", () => {
	test("a pinned header keeps its screen position: scroll up by the jump", () => {
		const el = header([75, -1925]);
		withFoldLanding(el, () => {});
		expect(scrollBy).toHaveBeenCalledWith(0, -2000);
	});

	test("an unpinned header already sits at its flow position: no scroll", () => {
		const el = header([300, 300]);
		withFoldLanding(el, () => {});
		expect(scrollBy).not.toHaveBeenCalled();
	});

	test("a collapse the browser clamped lands lower, not higher: keep the clamp", () => {
		const el = header([75, 120]); // document shrank past the scroll range
		withFoldLanding(el, () => {});
		expect(scrollBy).not.toHaveBeenCalled();
	});

	test("sub-pixel layout noise in the delta does not scroll", () => {
		const el = header([75, 74.8]);
		withFoldLanding(el, () => {});
		expect(scrollBy).not.toHaveBeenCalled();
	});

	test("a header removed by the toggle is left alone", () => {
		const el = header([75, -1925], false);
		withFoldLanding(el, () => {});
		expect(scrollBy).not.toHaveBeenCalled();
	});
});
