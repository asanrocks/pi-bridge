# ADR 0020: Pinned Model Order and the Pinned Default

**Status:** Implemented.

## Context

ADR 15 made the pinned group the picker's one curated tier, backed by pi's
global `enabledModels` scope. Two later changes made its *order* meaningful:

- A fresh Session's pre-session default model became the first pinned model, so
  the head of the list is now a product decision, not a rendering detail.
- The composer's model selection became a per-send carry (the stateless client
  API), which made "which model starts a new Session" a client-visible default
  rather than a daemon-resolved one.

The only pin control was `setModelPinned { provider, modelId, pinned }`: a
read-modify-write of the resolved scope that appended or removed one model and
persisted the flattened ids. It could not express position, and it flattened
`provider/id:level` entries to bare identities — so toggling any pin silently
dropped every level in the scope, which the pinned default depends on.

## Decision

**The pinned list has one mutation: replace it.** `setPinnedModels { models }`
carries the whole ordered list (identity plus an optional thinking level per
entry). The host filters what the catalogue cannot resolve, dedupes by identity
with the first position winning, writes the remaining order as the scope, and
announces the resulting list with the existing `pinned_models_changed` push.
The reply is acknowledgement only: a replacement is a proposal, the push is the
verdict. An empty list clears the scope, which is the "no pins" state.

**Pinning appends to the tail; dragging inside the curated group reorders.** The
append rule is what keeps the default stable: a pin never steals it, so the head
only moves when the user moves it. Reordering is confined to the curated group,
where every row is pinned, so a drop can never be ambiguous with the same model
in its provider group. The gesture is pointer-only: the app's global Alt+Arrow
chord already means "cycle active Session", and confining it to the picker would
ean stopPropagation-ing keys away from the document listener; choosing a free
chord instead is deferred until the reorder has proven itself.

**Order is live, membership is frozen.** The picker already froze its grouping
at open so a pin toggle could not move a row out from under the cursor; that
rule now covers the *copy* the portal keeps for its lifetime. A drag necessarily
moves rows, so the rendered order is the drag's coordinate space and the portal
applies each edit to its copy before sending it. The copy is what goes on the
wire, which means an edit made by another client while this picker is open is
overwritten — the same last-writer-wins window as two concurrent replacements,
deliberately not half-reconciled.

**The head is marked `default`.** A pin changes what the *next* new Session runs,
so the list states that fact where the order is edited.

## Consequences

- `setModelPinned` is gone: pin, unpin, and reorder are one client-side list
  edit (`web/src/features/composer/pinnedEdit.ts`) plus one verb.
- A drag does not auto-scroll the list and reordering has no keyboard path, so
  moving a pin across more than a screen is repeated drags; edge auto-scroll
  and a free chord are self-contained follow-ups.
- The level suffix round-trips verbatim, so an order edit cannot change what a
  pin means. Pinning a new model still writes no level (the model's own
  resolution applies until a level is set).
- Any edit flattens glob entries to concrete ids, as the old toggle already did;
  a `provider/*` scope becomes its expansion after the first interaction. This
  is a property of using pi's scope as the pin store, not of this change.
- Two clients replacing concurrently are last-writer-wins. The window is one
  push wide for a connected client, because pushes and requests ride the same
  socket, and is accepted rather than closed: a revision echo on the request
  would close it if it ever matters.
- The cycle order (Ctrl/Cmd+P) and the terminal client's own cycling follow the
  same scope, so reordering here is reordering there.
- A pinned model that is no longer authenticated is absent from the resolved
  list (the scope resolves against the available catalogue), so it leaves the
  reported list and the next replacement drops it from settings. Pre-existing
  behaviour of resolving the scope against availability.

## Alternatives

- **A move-intent verb** (`move X before Y`). Rejected: it needs drift rules for
  an unknown model or neighbour, a degraded-placement rule, and a decision
  between index and neighbour semantics — all of it to compute a list the client
  already holds. The full-list replace is one shape for pin, unpin, reorder, and
  any later bulk edit.
- **A bridge-local order overlay** over the resolved scope (bridge settings file
  holds the order, pi's file keeps membership). Rejected: two sources of truth
  for one list, and a default that can name a model the user never ordered.
- **A revision echo to close the stale-replace window.** Deferred: it is one
  field and a refusal path, and the window is currently bounded by a single
  push.
