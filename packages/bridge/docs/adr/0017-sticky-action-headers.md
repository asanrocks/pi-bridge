# ADR 0017: Sticky Action Headers

**Status:** Implemented.

## Context

An action group's fold control lives in its header row, and an expanded card's
fold control is its own tinted row. Both are in flow, so a group holding many
actions — or one card whose details are uncapped ("Show all", where the 300px
cap no longer bounds the body) — pushes the header off the top of the viewport
before the reader reaches the bottom of what it controls. Folding then requires
scrolling back, often thousands of pixels, in a conversation whose whole point
is that the reader can move between turns freely.

Three surfaces are in play:

- the document is the scroll container (a nested scroller would break mobile
  URL-bar collapse), the TopBar is fixed at `--topbar-h`, and nothing between
  the turn and the headers sets `overflow`, `contain`, or `content-visibility`;
- the renderer already derives grouping in the DOM: `.actionGroup` contains the
  header followed by `.groupLine` of `.action`s, each with `.actionHead`
  followed by its card;
- `useViewportTracking` captures a rewrap anchor by hit-testing the element
  under the viewport top, and restores that element's viewport position after a
  column-width change.

## Decision

A two-level sticky ladder, expressed entirely in CSS.

### Ladder

`position: sticky` is bounded by the element's containing block, and the DOM
already nests the two levels. So the ladder needs no state, no scroll listener,
and no measurement:

- **Level 1** — `.actionGroupHeader` pins at `top: var(--topbar-h)`, bounded by
  `.actionGroup`.
- **Level 2** — `.actionHead` pins at `top: var(--topbar-h)` standalone
  (user-bash turns, git-change turns outside a group) and at
  `calc(var(--topbar-h) + var(--group-head-h))` inside `.groupLine`, bounded by
  `.action`.

Push-out is inherent: the next sibling's header takes the slot when the previous
containing block ends. Collapsed elements need no gating either — a collapsed
group's containing block is exactly its header's height, and a collapsed
action's is its row (plus at most a short result preview), so pinning has
almost no range there.

### Height token

Level 2's offset needs level 1's height, which is a single nowrap line of
`--fs-sm` with 4px vertical padding. `--group-head-h` derives it
(`calc(var(--fs-sm) * 1.6 + 8px)`) rather than measuring it, so it tracks
`--ui-scale` with the font and needs no ResizeObserver. The header pins its
`line-height` to `1.6` so the derivation cannot drift from the rendered box.

### Opacity, not chrome

Content scrolls *under* a pinned header, so both surfaces paint opaque:
the group header with `--color-background` (its resting background was
transparent), the action head with its hue tint composited onto the page tone
(`color-mix(in srgb, var(--action-hue) var(--action-tint), var(--color-background))`)
— the tint itself is a translucent overlay on `.action`, which would let rows
show through. The group header's hover wash is composited the same way. The 3px
hue strip stays continuous beside a pinned head for free: it belongs to
`.action`, whose box spans the whole card.

Those two opaque surfaces are the *only* change to a pinned header. An earlier
revision added a seam (an inset hairline) and squared the pinned header's
corners to mark the boundary and stop a rounded corner leaking a sliver of the
content beneath. The seam was the wrong trade: it drew a grey rule through a
colour band that runs unbroken from the group tint to the card rows, which
reads as a divider between things that belong together. So there is no
`:stuck` styling at all — a pinned header looks exactly like a resting one, and
the reading position does the work of saying where the boundary is. The corner
leak it leaves is a 4px sliver at a single rounded corner, against a seam
across the full width on every pinned row.

### Anchor interaction

`captureAnchor` hit-tests the element under the viewport top. A pinned header
holds a constant rect top while the document scrolls, so capturing it would make
the recorded offset ambiguous and the restore would jump to wherever the header
un-sticks. The probe skips `[data-sticky-head]` hits and falls through to the
existing turn-boundary fallback, which is stable under pinning.

### Landing after a fold

A pinned header sits at its sticky line while its flow position has scrolled
past it. Collapsing removes the body below the header, so the pin goes inert
(the containing block is now the row itself) and the row falls back to its flow
position — up by exactly the distance it had been pinned. The document also
shrinks, which lets the browser clamp the scroll offset. Measured on a replica
(the real ladder CSS, a 1500px-deep card fold): the clicked row went from
y=75 to y=-21 and the viewport from 1585 to 106, i.e. the reader was thrown to
the tail with the row off-screen above.

So the fold lands where it was clicked: the header keeps its screen position and
the body slides up beneath it — for a card, that is directly under the pinned
group header. The correction (`withFoldLanding`) records the header's top
before the toggle and, in a rAF after the commit, scrolls by the difference
between the new and old tops. That needs no pin line to be named, and an
unpinned header (already at its flow position) produces a zero delta, so the
common fold does nothing. It is upward-only: when the document shrank past the
scroll range the browser's clamp already parked the reader somewhere sane, and
scrolling down to a row nobody asked to see would be worse.

The rAF, not the click handler, is the measurement point: React flushes the
discrete event's commit after the handler returns, and rAF runs before paint, so
the corrected position is painted with the collapsed layout instead of after a
visible jump. `useViewportTracking`'s scroll listener treats a shrunken
document as a clamp rather than user intent, so the correction cannot arm or
disarm follow, and folds never drive auto-scroll.

Keyboard folds (the focused turn's first group) take no correction: focusing a
turn top-anchors it, which leaves that group's header below the fold line.

## Alternatives considered

**Group header only.** The group header is the master toggle (collapsing it
resets every card below), so it alone makes the whole fold reachable. Rejected
because the card row answers a second need: re-reading a long diff or command
output while keeping the file/command identity and the copy/show-all controls'
context in view.

**A floating fold chip next to the jump-to-bottom button,** resolving "the group
the viewport is inside" with an IntersectionObserver. Zero height cost, but it
adds scroll-driven state and an observation surface to every group, and it loses
the inline summary that says *which* group is being folded.

**Auto-collapse a group when it scrolls out.** Rejected: it overrides the frozen
set, so streaming re-renders would fight a rule about user intent, and it folds
content the reader is still reading.

**Three levels** (turn header as well). Rejected: 48px top bar plus two pinned
rows is already the mobile budget; a third would eat the reading area.

## Consequences

- While a group sits under the ladder, the reader loses up to
  `--topbar-h` + two header rows of viewport (about 100px at scale 1). Both
  levels are one line each and shrink with `--ui-scale`, so the cost is bounded
  and proportional.
- A capped card (300px details region, own scroller) gains nothing from level 2
  beyond its header staying visible; the cost is one sticky element per
  `expanded` card, since collapsed rows never pin.
- `scrollIntoView` on turns keeps using `scroll-margin-top`; a target's own
  pinned group header sits inside the anchored box, so the anchored turn's top
  is the only thing the margin has to clear.
- The pinned bar carries no card controls: copy, wrap, markdown, show-all, and
  the viewer eye still live in the card's own top bar, which scrolls away. Moving
  them onto the pinned row is a separate change.
- Folding is now a scroll-affecting interaction: the correction runs one frame
  after the toggle, and its scroll event is bookkept as a clamp (shrunk
  document) or as an upward move when the collapse caused no clamp. Neither
  changes the reader's follow state in practice — a header can only be pinned
  when the viewport is not at the live end.
