// ============================================================================
// foldLanding — a fold lands where the reader clicked it (ADR 0017).
//
// A pinned header sits at its sticky line while its *flow* position has
// scrolled past it. Collapsing removes the body below the header, which makes
// the pin inert (the containing block is now the row itself) and lets the row
// fall back to its flow position — up by exactly the distance it had been
// pinned, i.e. up to the whole body for a card the reader scrolled deep into.
// The document then shrinks under the viewport, so the browser may also clamp
// the scroll offset, which lands the reader somewhere else entirely (measured:
// folding a card pinned 1500px deep dropped the viewport to the new tail with
// the clicked row off-screen above).
//
// So the rule is: the fold control keeps its screen position, and everything
// after it slides up beneath. Before the toggle the header's top edge *is* its
// pin line; after it the same edge goes to its flow position. Scrolling by that
// difference is the landing — no pin line needs to be named, and an unpinned
// header (which sits at its flow position already) yields a zero delta, so the
// common fold does nothing.
//
// Expanding needs no correction: inserting content below a header does not move
// it. The correction is upward-only on purpose — a collapse that shrank the
// document past the scroll range keeps the browser's clamp rather than scrolling
// down to a row the reader never asked to see.
// ============================================================================

export function withFoldLanding(el: HTMLElement, toggle: () => void): void {
	const before = el.getBoundingClientRect().top;
	toggle();
	// The commit for a discrete event lands before the next frame, so measuring
	// in rAF reads the collapsed layout — and rAF runs before paint, so the
	// correction is painted with it instead of after a visible jump.
	requestAnimationFrame(() => {
		if (!el.isConnected) return;
		const delta = el.getBoundingClientRect().top - before;
		if (delta < -0.5) window.scrollBy(0, delta);
	});
}
