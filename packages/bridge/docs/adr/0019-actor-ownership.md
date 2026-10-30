# ADR 0019: Actor Ownership

**Status:** Proposed.

## Context

Three lifetimes run through the bridge, and each is currently represented
by several owners whose state must agree after every `await`:

- A **Session's runtime lifetime** (create, admit work, observe, collect) is
  spread across `ActivationRegistry` (indexes, reservations, terminal flags,
  GC timers, the disposal promise), `SessionExecution` (mutation ordering,
  tracked work, the terminal `end`), `SessionLease` (the release flag), and
  `Manager.dispose` (the memoized teardown).
- A **Connection's transport lifetime** is spread across the socket handler,
  the transition `LifecycleScope`, the sync-attribution window, and the
  daemon's teardown snapshot.
- The **browser's committed view** is spread across the navigation reactor
  (intents, epochs, abandoned targets, cancelled transitions), the
  connection pipeline (patch coalescing, cache write-through, the shared
  `cacheBase`), and the store.

Each owner is individually careful, and the recent fix history is almost
entirely seam races between them: a stale handle re-entering disposal, a
late initial sync committing over a successor, a release that should have
been a drain, a terminal answered with a flag instead of a join. The
surviving guards — `ended`, `collecting`, `intentEpoch`, `abandoned`,
`cancelled`, `openEpoch`, `syncAttribution` — are compensating checks, and
each fix has tended to add another state bit beside them rather than
remove one.

Two earlier lines each tried to solve this by adding a layer, and both
failed the same way: the new layer modeled a lifetime the domain already
had, becoming a second authority beside it.

- The Worker composition (the `feat-mux` line) separated transport from
  execution — the right boundary — but represented it as a
  registration/claim/slot/observation system beside the existing
  Project/Session/Activation model, and the Worker became a second, larger
  god class.
- The persistency layer (the `backup-persistency-layer` line) made cache
  validity explicit — the right discipline — but as a second conversation
  authority (index/description/payload records with their own fingerprints
  and heads) beside the canonical Document, whose correctness then depended
  on protocol machinery patched around the split (index deltas, payload
  splices, delivery baselines, chain caches).

## Decision

Give each lifetime one **actor**: a serialized owner built on the existing
reactor primitive, whose every state transition is one applied message,
whose asynchronous completions return as ordinary messages, and whose
`close` is the joinable terminal drain of the state and the resources
together. Three actors, one per layer, with typed capabilities as the only
path between them:

1. **The Session actor** owns one Session's runtime: the Manager, the
   canonical Document, pi event subscription and the refresh boundary,
   command admission, observation registration, the Git observation
   children, and terminal teardown (`creating → live → closing → closed`).
   Clients hold a `SessionCapability` — the registration identity, the two
   admission classes, observation registration, and a joinable release.
   Observations are independently releasable `ObservationCapability`s.
2. **The registry** is an index, not a co-owner: address → actor, pending
   creation, durable session-id uniqueness, and address reservation while
   an actor closes. It never owns admission, observation sets, or disposal
   state.
3. **The Connection** is a protocol adapter: the socket, RPC correlation,
   the current capability, subscriptions, and its own serialized attachment
   transitions. Handlers are typed verb modules that capture a capability
   at entry; the Connection interprets no Session state and enforces no
   navigation policy.
4. **The browser view actor** owns the committed view, the pending
   transition, the cache candidate, the route, and store publication. The
   transport pipeline delivers typed observation events and decides
   nothing; cache restore returns values the actor chooses to apply or
   discard.

Delivery is generation-tagged: every observation frame names the attachment
that produced it, and the view drops a frame whose generation is not the
committed one — the reactor's epoch rule applied at the wire.

The contracts land ahead of the machinery (`src/host/session-actor.ts`,
`web/src/infra/net/viewEvents.ts`) with characterization tests pinning the
four properties the refactor must preserve: a command completes against
the runtime it captured across a release; observation release is
idempotent and per-observation; the terminal boundary is joinable with one
disposal; nothing is admitted and nothing is delivered after a release or
the terminal boundary.

## Migration

Behavior-preserving slices, each leaving the bridge suite green:

1. The contracts and their characterization tests (this change).
2. Introduce the Session actor: it absorbs `SessionExecution`, observation
   registration, Git observation teardown, and disposal; the Connection
   holds the capability and the lease is deleted.
3. Thin the Activation registry to the index and reservation layer.
4. Split the Connection into the protocol adapter with typed handlers.
5. Tag observation frames with the attachment generation; the browser drops
   stale generations.
6. Extract the browser view actor from the navigation reactor.
7. Make the transport pipeline and cache restore value-only.
8. Delete the superseded machinery; fold the model into the permanent docs
   and merge this record.

## Alternatives considered

- **Keep and patch.** The guard census grows with every seam fix; the
  history shows the fixes work but the model does not converge.
- **The object kernel** (ADR 8, already rejected): a generic peer/registry
  would be a second model of a domain that already has names.
- **The Worker composition** (`feat-mux`): the transport/execution boundary
  is retained as a future adapter behind the ExecutionLink, not as a second
  object system.
- **The persistency layer** (`backup-persistency-layer`): cache validity
  stays explicit, but over one canonical conversation authority, not a
  second one.
- **A generic actor framework.** Actors exist only where there is mutable
  state, asynchronous effects, ownership, and stale-completion risk; pure
  core functions stay pure, and actor-to-actor calls stay typed
  message-and-result, never closures over internals.
