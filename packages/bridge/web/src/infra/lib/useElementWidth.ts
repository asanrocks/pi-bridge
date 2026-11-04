// ============================================================================
// useElementWidth — the measured inline size of one element.
//
// The conversation column decides the turn header's density (ADR 21), and a
// container that can be a phone, a narrow desktop pane, or a wide column has no
// media query that answers "how wide am I": the pane is resizable and the
// document is the scroll container, so the viewport is silent about it.
//
// ResizeObserver, not a window `resize` listener: a pane drag changes the
// column without changing the window. The reading is taken in a layout effect
// before the first paint, so the header's first frame already has a width and
// controls do not jump out of the menu on mount.
// ============================================================================

import { type RefObject, useLayoutEffect, useState } from "react";

export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const element = ref.current;
		if (element === null) return;
		// `contentRect` is the content box, which is what a row inside the
		// column's padding can actually use.
		setWidth(element.getBoundingClientRect().width);
		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) setWidth(entry.contentRect.width);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width;
}
