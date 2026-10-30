# ADR 0018: Row states — identity and position

**Status:** Implemented. The rule now lives in
[design.md](../web/design.md#row-states) and is gated by
`scripts/check-bridge-styling-tokens.mjs`; this record is deleted at merge.
The review sheet that decided it (`/rows.html`, four schemes) was a dev-only
prototype and is not kept as a second specification.

## Context

A list row has four visible states — selected or not, times hovered or not —
but only two dimensions: **identity** (persistent: the session you are attached
to, the model in force, the file you opened) and **position** (transient: the
pointer, or the keyboard cursor in a list that moves one). Each feature
currently answers the four states separately, and the answers disagree:

| | Sidebar session row | Model picker row |
| --- | --- | --- |
| position | `--color-muted` fill | `--color-muted` fill |
| identity | `--color-accent-soft` fill | `--color-muted` fill + 2px accent left band |

Three defects follow from that table, and all three are visible in the app:

1. **The picker's identity fill is the hover fill.** The band is the only thing
   carrying selection, so selected and hovered are one style plus a mark, and
   selected+hovered is identical to selected.
2. **The sidebar's identity fill and hover fill differ only in hue.**
   `--color-accent-soft` (#e1e8ef) against `--color-muted` (#e8e4dc) is 1.03:1
   in luminance: a cool wash and a warm wash at the same lightness. That is why
   the picker's author reached for a band in the first place.
3. **A collision forces a per-state override.** Because position and identity
   share the fill channel, `sidebarItemSelected:hover` has to paint the
   identity fill back over the hover, so a selected row cannot acknowledge the
   pointer. Every such override in the app is this same collision.

A fourth, in the picker's surroundings: the group headers paint
`--color-sidebar`, 1.09:1 from `--color-muted`, so "Pinned" and "DeepSeek" read
as hovered rows. A structural band has taken the pointer-feedback channel.

## Decision

**Identity is the accent tint; position is the neutral fill. The two dimensions
share the fill channel, but they are hue-locked so that every combination is
readable without a second style.**

| | not selected | selected |
| --- | --- | --- |
| **rest** | no fill, `--color-foreground` ink | accent tint at 30%, name at weight `500` |
| **position** (hover, keyboard cursor) | `--color-muted` | accent tint at 42% |

The tint is an alpha over the row's own surface (`color-mix(in srgb,
var(--color-accent) N%, transparent)`), the way `--action-tint` is applied, so
the white portal and the chrome sidebar keep the same relative jump instead of
needing one hex per host. The selected+hover value is the same hue's next step,
not a second channel: the pair is transient, and the pointer is already
distinguished by the row's hover-revealed control.

Three things make this the answer rather than a taste call:

- **The pair differs in hue, not only in depth.** Position is the warm neutral
  (`--color-muted`), identity is the cool accent. A warm gray and a blue wash at
  similar luminance are distinguishable at a glance; two warm washes (today's
  `--color-accent-soft` at 1.03:1 from `--color-muted`) are not.
- **Ink is untouched.** Rest stays `--color-foreground`, so the list does not
  dim and the name/meta split keeps its ink step. Weight `500` on the selected
  name is a second, non-color channel — it is the ladder's soft-emphasis weight
  (`design.md:850`), not a new one.
- **No state needs an override.** `sidebarItemSelected:hover` disappears:
  hover on a selected row is its own declared value, so selection and pointer
  feedback coexist.

Row families, so the escape hatches have names rather than being discovered per
feature:

- **A. Navigation rows** (sidebar, launcher, model picker, file tree): identity
  is the accent tint, position is `--color-muted`.
- **B. Semantic rows** (history graph, action rows): the fill is already spent
  on meaning, so position is a stronger alpha of the same hue and identity moves
  to the row's own mark column (history's node dot is already filled for
  "current") or the edge if it is free.
- **C. Content rows** (cards, turns): no row states at all.

Two supporting rules come out of the same table:

- **A rest fill may not consume a state token.** Group and section headers get
  no fill; they are a hairline plus an uppercase `--tracking-caps` label. (They
  are also sentence-case today, a separate drift from the same rule.) Today's
  header fill is 1.09:1 from the row hover fill, so "Pinned" reads as a hovered
  row.
- **Reveal follows position, not the pointer.** A hover-revealed row control
  (the picker's pin, the sidebar's row menu) must appear for the keyboard cursor
  too. Today `.portalItem:hover .portalPin` reveals the pin to a mouse only, so
  Shift+Enter's target is invisible to the user who needs it.

## Alternatives considered

**A — keep the band (the picker today).** The only mark is a 2px accent stripe on
the leading edge, which is a gutter the row does not always have (the sidebar's
rows are flush with the folder), and the fill underneath it is the hover fill,
so selected+hover is identical to selected. Rejected: a scheme that cannot
render one of its own four states.

**B — identity as ink, position as fill.** Selected is `--color-foreground` at
weight 500, unselected rests at `--color-secondary`, position is
`--color-muted`. It composes perfectly and needs no new token, and it was the
first recommendation on the sheet. Rejected after review: the selected row is
too quiet to be found without reading it — and the two-level ink ladder dims
every other row to pay for it. Selection has to be findable at a glance, which
ink alone does not deliver at 13px.

**C — pale tint identity, overlay position.** Material's state layer: selection
changes the base, hover composites a translucent overlay on top. Rejected on
arithmetic: over `--color-accent-soft` (1.03:1 from the hover fill) the overlay
must reach roughly a third of the way to `--color-foreground` before it reads,
and at that strength hover on a white row is louder than every other hover in
the app. The failure was the pale base, which is what D fixes; the overlay
mechanism itself is not needed once the base has a real delta.

**D′ — accent ink for identity.** `--color-accent` as the selected row's text
would avoid any fill. Rejected: accent as text on the sidebar chrome is 3.8:1,
below AA for a 13px label; the darker `--color-accent-hover` passes at 4.9:1 but
would need an `--color-accent-text` token, and it still only marks one row with
a hue the eye reads as a link.

**VS Code's active/inactive selection.** Two selection intensities, switched by
whether the list has keyboard focus. Correct for a composite widget with a
roving focus model; these rows are plain buttons with no such state, so the
third intensity would have nothing to derive it from.

## Consequences

- **Two new tokens, one tunable number each.** The tint strength is a single
  value in `@theme`, so a review that wants it louder or quieter changes one
  line rather than five feature modules. `--color-accent-soft` loses its last
  identity consumer and should be removed if family B or a mark-based identity
  does not adopt it.
- **The 1.4:1 state-fill floor does not apply as written.** That invariant was
  written for a control's hover/engaged fill, where hue is constant and depth is
  the only channel; here the two dimensions differ in hue as well, and identity
  also carries weight. At 30% the tint is 1.28:1 on the chrome and 1.30:1 on the
  white portal — above the point where a fill reads as texture, below the
  control floor. If the floor is held absolute, the same scheme at 38–40%
  satisfies it and simply reads louder.
- **`aria-current` / `aria-selected` becomes load-bearing.** Identity is a tint
  plus weight, so the non-visual channel must exist: the sidebar already sets
  `aria-current="page"`; the model picker's rows set nothing today.
- **A gate is required, as with the icon contract.** The rule that failed here
  is a channel used by the wrong dimension, which is checkable in CSS: a
  `:hover` rule must not paint the identity token, a rest fill must not resolve
  to a state fill, and rows must draw from the row-state token set only. Without
  it, the next feature re-derives the four styles from scratch — six hand-rolled
  buttons survived three sweeps before the icon contract existed.
