# ADR 0021: Compact Turn Headers with Details and Action Menus

**Status:** Implemented. The rules now live in
[web design](../web/design.md#turn-types) and the moved git-review affordance in
[git affordances](../web/design.md#git-affordances); this record is deleted at
merge.

## Context

User and assistant turn headers mix timestamps, role or model names, timing,
context usage, git identity, labels, and action controls in one line. On a
phone, always-visible touch controls leave too little room for the metadata.
Some text shrinks without clipping and paints over neighbouring items; other
items truncate before the reader can identify them. Narrow desktop conversation
columns have the same problem.

Fixing overflow alone would produce a row of partial values. The information
also needs a hierarchy: a few fields help readers scan the conversation,
statistics explain a turn, and commands act on it.

The current mechanisms and constraints are documented in
[web design](../web/design.md#conversation-rendering),
[web architecture](../web/architecture.md#viewmodel-projection), and
[git affordances](../web/design.md#git-affordances).

## Decision

Use a compact header for user and assistant turns. Keep scanning information
visible, open turn statistics from the date, and collect secondary commands
in a trailing action menu. Desktop and mobile share the same order:

```text
Date disclosure | Existing label | Context usage | Default controls | Menu
```

Missing fields take no space. There is no empty label placeholder. The
header does not expand into a full metadata strip on desktop.

Illustrative layouts below use words for icon controls; the implementation
uses the shared icon registry and time formatters.

```text
User, wide
1 min ago [details]   #draft                    Copy  [1 / 3]  Edit  More

User, narrow
1 min ago [details]   #draft                                  Edit  More

Assistant
just now [details]                                17%      More

Assistant, streaming
just now [details]                     working for 12s · 2 running
```

### Visible information and controls

- **Date:** retain the shared relative/calendar time ladder. The date is a
  button containing the semantic time element and a disclosure caret.
  Its accessible name includes "Turn details" and the precise timestamp.
  A missing or invalid instant keeps the trigger's shape as a clock mark rather
  than a `Details` word (the slot names a time everywhere else), and a streaming
  turn names its start anchor until its own entry seals — an unsealed turn has
  no instant of its own, and naming none would leave every reply's first seconds
  without a date.
- **Label:** show an existing user-turn label immediately after the date.
  It is the flexible-width field and ellipsizes within its allocated space.
  Its full value remains available when editing it. Label creation moves
  into the action menu; clicking an existing label still opens its editor.
- **Context:** show the rounded percentage alone on assistant turns when known
  (`17%`) — the composer renders the same reading the same way, so a descriptor
  here was inconsistent and took the width a label needs. Its meaning and its
  change against the previous reading are the details panel's and the reading's
  tooltip. Do not substitute the current Session's context usage for an
  unavailable historical reading.
- **Default controls:** retain Copy, sibling navigation when applicable, and
  Edit on wide user-turn headers, ordered pager → Copy → Edit. The optional
  pager takes the leading slot because a right-anchored row measures each item's
  distance from the items to its right, so prepending it leaves the fixed
  controls where they are; the fixed run then descends by frequency with the
  menu last. The menu orders by likely use rather than mirroring the row. Compact
  headers move those controls into the menu according to the width policy below;
  Edit rather than Copy is the compact keeper because Edit is the correction
  path. Assistant copying
  remains per message because a merged assistant turn can contain several
  messages.
- **Menu:** keep the trailing overflow control visible and keyboard
  reachable at every width. It opens commands for that turn that do not
  currently have a visible header control.

The visible "You" label, model/provider label, completed durations, user
deliberation interval, and git identity leave the header. The user tint and
assistant layout continue to distinguish roles visually; accessible turn
descriptions retain that distinction.

### Date opens turn details

The details panel is a labeled information view, not an action menu. Show
applicable, available fields as readable label/value rows:

| Field | Meaning |
| --- | --- |
| Time | Precise instant, including timezone |
| Model / Provider | Recorded producer represented by the turn, as two rows |
| Duration | Estimated elapsed turn time, including queueing and inter-request latency |
| Tools | Estimated tool share; parallel tool time is not summed; omitted below a second, which also covers the zero of a tool-free turn |
| Context | Percentage and available change from the previous reading |
| Since last reply | Estimated gap from the previous assistant completion to a user send |
| Branch | Recorded branch at send (absent on a detached head) |
| Commit | Recorded short commit at send (absent on an unborn branch) |
| Subject | That commit's subject when available (absent on v1 stamps) |

Omit unavailable fields rather than inventing zeroes or estimates, row by row.
Label estimated durations as estimates. "Since last reply" names a measurement,
not a moment, and does not claim that the user spent that time thinking.

Use an anchored popover where it fits. In constrained mobile layouts,
present the same content in a bottom sheet with a visible close control.
Long values wrap, and the panel scrolls within the available viewport.
Neither presentation relies on hover or a title tooltip.

### Menu contains turn commands

The menu is an overflow owner, not a duplicate toolbar. Each command has
exactly one visible owner at a time:

- A command shown as a header control is absent from the menu.
- A command moved out of the header is present in the menu.
- Resizing the conversation column may move a command between the header and
  the menu, but never shows both copies simultaneously.
- The menu trigger itself is always visible; it is not a duplicate of the
  commands it reveals.

The user-turn menu contains commands displaced from the header, plus commands
that have no permanent header control: Create label when the turn has no
label, and applicable git review actions. An existing visible label remains
the direct edit trigger, so the menu does not also offer Edit label. If a
future responsive rule removes that label trigger, the menu may temporarily
own Edit label instead.

For turns with siblings, the wide header owns the pager when it is shown.
When the pager moves into the menu, the menu owns Previous branch / Next
branch and the current sibling position. Preserve the existing
real-navigation versus read-only-peek behavior and endpoint availability.

Git review items retain their existing explicit endpoint pairs: each
recorded transition, the union of multiple transitions, and comparison to
the current worktree only for the live path's last user turn with a baseline.
Moving these items out of the git chip does not widen their scope. Keep the
items in the turn menu rather than introducing cascading submenus.

The date is the sole details trigger. The menu does not repeat "Turn
details", and no whole-turn Copy action is added for assistant turns.
Creating or editing a label opens a bounded editor rather than inserting an
unconstrained input into the header.

Existing mutation, connection, busy-state, and peek restrictions still apply.
An unavailable command cannot bypass its gate through the new menu.

### Responsive and interaction rules

Base compact modes on the actual conversation container width, not pointer
type or viewport width. A narrow desktop pane must behave like a phone.
Choose breakpoints against the shared control sizes and enlarged text during
implementation; there is no per-widget width measurement or packing algorithm.

Reserve space for the date, context reading when present, and menu first.
Bound and truncate the label, then move default controls into the menu at
the compact breakpoints. The width policy is exclusive: a command is either
in the header or in the menu, never both. Every text item must remain inside
its allocated box. No header text, control, or touch target may overlap
another.

The normal layout is one line. If the essential fields cannot fit after
default controls have moved into the menu, allow a second line rather than
clipping values, reducing text size, or shrinking touch targets. This
fallback covers long calendar labels and enlarged text.

Follow the shared styling tokens, button tiers, icon slots, and touch-target
rules in [web design](../web/design.md#iconography-and-control-surfaces).
The date is a value disclosure, like the existing cost readout; any new
control classification must be recorded in the icon-contract gate.

Date and menu triggers support Enter and Space, expose their expanded state,
and have visible focus. Action menus implement menu keyboard navigation;
details use information/dialog semantics. Escape dismisses the active
surface, dismissal restores focus appropriately, and opening one closes the
other. A modal mobile sheet contains focus and has a labeled close control.
Session changes or removal of the owning turn dismiss its transient surfaces.

### Live status and errors stay visible

Moving statistics behind the date must not hide progress. While an assistant
turn is streaming, its live elapsed time and running-tool count take the
header's trailing reading slot, which the context reading cannot be using yet:
that percentage only exists with the turn's last usage, so the two never
compete. The status therefore costs no second line, and the slot swaps in place
at the seal instead of the header losing a row. It remains visible even before
text or tool results arrive, and if it cannot fit beside the date the header's
own second-line fallback applies. After completion, duration is available
through turn details.

Errors, interrupted-turn recovery controls, and editing indicators remain
visible in the conversation. They are not statistics or overflow actions.

## Alternatives

- **Dedicated Details button:** clearer initial discoverability, but repeats
  another control on every turn and competes with labels and actions on a
  phone. The date disclosure includes a caret and a menu fallback instead.
- **Permanent two-row metadata header:** keeps model and duration visible,
  but adds vertical space to every completed turn and still requires rules
  for long values. A second line is reserved for essential-field overflow
  and a separate status row for active work.
- **Customizable pinned widgets:** supports individual preferences, but
  requires ordering, persistence, and responsive degradation policies before
  fixing the default experience. Deferred; this proposal introduces no
  widget registry or layout settings.
- **Ellipsis-only repair:** stops collisions but leaves unreadable fragments
  of information competing for space. Overflow containment is necessary
  alongside the information hierarchy.

## Consequences and implementation scope

This is a web presentation change using existing turn data and commands.
It requires no new protocol fields, host statistics, or persisted preferences.
System, user-bash, git-change, and action-group headers retain their current
roles.

Completed model and timing information costs one interaction to inspect.
The date's broader meaning needs validation on touch devices. The overflow
menu provides a fallback route without adding a permanent button.

Shipped as `features/conversation/TurnHeader.tsx` (the one header layout: date
disclosure, label slot, trailing reading, inline controls, menu, and the one
open panel at a time), `TurnDetailsPanel.tsx` (the ledger behind the date:
hairline-separated sections of labelled rows, not the flat labelled list this
record first described), `LabelSlot.tsx` (`LabelChip` plus `LabelEditor`),
`headerDensity.ts` (the tier policy and the exclusive-ownership matrix),
`turnDetails.ts` (the ledger's rows as data, so the reporting rules are testable
without a DOM) and `infra/lib/useElementWidth.ts` (column measurement). Density
follows the measured conversation column: at least 560 CSS px keeps the pager,
Copy, and Edit inline, 340–559 keeps Edit, and below that the menu is the
header's only control. Ownership stays exclusive as decided
above — the earlier note here that "the menu carries every command at every
width" contradicted that rule and is replaced by it. An assistant turn has no
header command, so it renders no menu trigger rather than an empty menu; the
details panel is one anchored surface rather than an anchored popover with a
separate mobile bottom sheet (it is width-capped and its body scrolls, so the
phone case is the same surface), and the label editor is a panel with Save and
Cancel rather than an inline field.

Anchored surfaces are unchanged: `render/Popover.tsx` owns the backdrop, the
chrome, the CSS anchor placement, and the capture-phase Escape, and this change
reused it rather than adding a family. `render/AnchoredMenu.tsx` gained the
menu-button keyboard support this record's verification requires — first-item
focus on open, arrow/Home/End roaming, and focus return to the trigger on
dismissal — which the shared menu previously lacked. Design rules for the family
live in web design's [styling invariants](../web/design.md#styling-invariants).

**Departures from the table above.** The header's commands, the menu trigger
included, keep the reveal every other hover-revealed control has: they fade in on
hover, focus, or the keyboard cursor and are simply visible on touch, so the
"always visible" wording above is about ownership (the trigger is never a
duplicate of the commands it reveals), not about ink. The `Editing` badge is
state, so it stays outside the revealed group and is visible while the turn is
the edit target. The rows are grouped as hairline-separated
sections rather than one flat list, and the ledger no longer composes facts into
single values. The repository state split into `Branch`, `Commit`, and `Subject`
instead of a `branch @ commit — subject` string, because a branch and a commit
are different facts and the subject belongs to the commit; every row then hides
on its own. The provider is its own row rather than part of a composed model
label, which removes the duplicated parenthetical a catalog name like
`DeepSeek V4.1 Flash (Volcengine)` produced against a provider display name of
`Volcengine Gateway`. Sections need no headings: sectioning was tested against
the cost popover, which needs none because every value there is money, while
these values are heterogeneous, so the divider groups and the labels
disambiguate — the opposite assignment from the same anatomy. Estimated spans
carry a `~` in the value instead of `(estimated)` plus a footnote, because the
suffix and the sentence were the panel's most costly prose. Rows are one
two-column grid for the whole panel, joined by the sections through `subgrid`
with left-aligned values and baseline-aligned labels, not the right-aligned
key/value pair this record inherited from the cost ledger: that alignment suits
a column of numbers, while a wrapped commit subject is ragged on both ends.

The owning conversation, git-affordance, control, and responsive rules in web
design, the timing paragraph in web architecture, and the user-turn rendering
description in [git stamps](../host/git-stamps.md#web-rendering) were updated in
the same change. Verification status: type checks, the styling and icon gates, and
the header, density, ledger-row, panel, and live-status unit tests pass. Browser
checks (narrow containers, touch targets, panel focus, wrap fallback) remain
outstanding and are listed above.

## Verification

Implementation acceptance must cover:

- Narrow conversation containers at 320 and 375 CSS pixels, a narrow desktop
  column, and enlarged text: no painted-text or touch-target overlap, and
  every action remains reachable.
- Missing metadata, long dates, labels, model/provider names, branch names,
  many recorded commits, and large sibling counts.
- Mouse, touch, and keyboard opening, navigation, dismissal, and focus
  restoration for details, menus, and label editing.
- Correct historical statistics and git endpoint pairs, plus preserved busy,
  disconnected, editing, and read-only-peek gates.
- Streaming before the first content delta, tool-only turns, completion,
  errors, and interrupted-turn recovery.

Run focused web tests for the changed behavior and the root `npm run check`
after code changes. Geometry and touch behavior require browser verification;
component tests alone do not establish that the mobile layout fits.

## References

- [Progressive disclosure — Nielsen Norman Group](https://www.nngroup.com/articles/progressive-disclosure/)
- [Menu button pattern — WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/)
- [Target size minimum — WCAG 2.2](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
