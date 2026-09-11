# ADR 08: Object Kernel — Directory, Peers, and Per-Facet Sync

**Status:** Proposed. Does not replace ADR 06 yet; supersession happens when
this reaches Accepted and the implementation lands.

## Context

ADR 06's component model serves the v1 web client well, but five goals strain
it:

1. **Client-neutral protocol.** The wire is shaped by the web client's needs
   (`replace`/`patch` push + typed verb RPC); a CLI or TUI client has no
   first-class path in.
2. **Incremental sync.** The web client wants to cache conversation history
   (IndexedDB) and sync only what's new. v1 has no resumable cursor: a
   reconnect re-sends the full `replace` snapshot.
3. **Real M:N.** A Connection is *attached* to one Manager. Attachment — a
   server-side pointer the Daemon mutates — encodes what a client sees. A
   dashboard monitoring all instances in real time cannot be expressed.
4. **Holistic design.** Sync applies only to an instance's Document; registry,
   sessions list, and lifecycle ride an RPC sideband plus ad-hoc push kinds
   (`sessions_changed`, `instance_exit`) and polling (`listInstances` every
   5s).
5. **Daemon/instance RPC entanglement.** The Connection demuxes verbs into
   three buckets (session → Manager, daemon → Daemon, `pull` → self); the
   Daemon reaches into `manager.document` to enrich `listInstances`.

Under all five lies one hidden assumption: *what a client sees is encoded
server-side, in the attachment pointer.* This ADR removes that assumption.

## The model

The daemon stops being a protocol component and becomes an **IPC kernel**: a
directory of addressed objects plus a router. Everything with state or
behavior — pi instances, clients, meta objects — is a **peer object** with
methods and subscriptions of its own.

```
┌─────────────────────────────────────────────────────────────┐
│ Daemon = IPC kernel (no semantics)                          │
│   Directory: flat Map<id, deliveryEndpoint>                 │
│   Router: resolve `to`, validate envelope, stamp `_from`    │
│   Liveness: transport closed → remove entry → publish       │
└──────┬──────────────┬──────────────┬────────────────────────┘
       │              │              │
┌──────▼─────┐ ┌──────▼─────┐ ┌──────▼─────┐
│ Instance   │ │ Instance   │ │ Client     │  ... peer objects
│ obj #2     │ │ obj #7     │ │ obj #5     │  (own state, own
│ pi runtime │ │            │ │ mirror +   │   subscriptions)
│ journal    │ │            │ │ wants      │
└────────────┘ └────────────┘ └────────────┘
       ▲              ▲              ▲
       └──────────────┴──────┬───────┘
                             │
                     Meta objects (directory,
                     lifecycle, debug) — daemon-hosted
```

**The daemon owns addresses, not semantics.** A message is
`{ to, from, method, params, id? }`; the kernel resolves `to` to a delivery
endpoint (in-process callback or WebSocket) and forwards. The payload is
opaque; only the envelope is typed and validated. A malformed message must
not crash the server. Security is not enforced at this layer — every payload
is trusted (localhost, single-user; see Trust boundary for the two
exceptions).

### Envelope

JSON-RPC-like, **symmetric** — the same envelope flows in both directions.
There is no push/RPC asymmetry: `onPatch` (instance → client) and
`onUserMessage` (client → instance) are the same mechanism.

```
// client #5 sends a message to instance #2
{ to: 2, method: "onUserMessage", params: { text: "Hello" }, id: "r1" }
// kernel stamps _from: 5 before delivery

// instance #2 streams a delta to client #5
{ to: 5, method: "onPatch", params: { path: "/entries/e9/thinking",
                                      op: "append", value: "Let me run npm" } }
```

A frame with `id` is a call (reply carries the same `id` plus an outcome); a
frame without `id` is a notification. Replies carry only the failure/result
channel — observed state flows through notifications (ADR 06 §7.13's spirit,
restated).

### The directory object

- **Flat, growing id list.** Ids are never reused; a new pi instance or a new
  client connection gets the next unique id. Restart resets everything
  (accepted: state objects are re-read on reconnect anyway).
- **Both sides register.** Clients and instances appear in the directory as
  peers (`client #5`, `instance #2`).
- **The directory is itself a subscribable object.** Join/leave of entries
  publishes as change records to its subscribers. This is the registry feed:
  a dashboard subscribes to the directory and to per-instance objects; the
  5s Launcher polling dies.
- **Two removal paths, no enforced broadcast.**
  - *Elegant exit* — the object's own business. `killInstance` is a method
    call *to* the instance; it abort-saves, notifies its own subscribers (its
    choice), then deregisters. Nothing pulls a live object from the registry.
  - *Mechanical removal* — the kernel's business. Only on actual death: the
    object exited, or its transport closed. Socket closed → entry removed →
    directory publishes. This bookkeeping is transport-level; no payload
    inspection.
- No special `peerGone` mechanism: dead-client subscription entries inside a
  non-subscribing instance are inert (routing to a dead id fails) and are
  cleaned at instance dispose. Instances that want hygiene subscribe to the
  directory — the same feed a dashboard uses.

### Object kinds

| Kind | Hosted by | Owns |
|---|---|---|
| Instance object | daemon process | pi runtime, canonical Document, entry journal, method table, subscriptions (keyed by client id) |
| Client object | client side (peer over WS) | DocumentMirror, cache, wants/pull orchestration |
| Meta objects (directory, lifecycle, debug) | daemon process | registry state, `newInstance`/`killInstance` implementation, introspection |

`newInstance`/`killInstance` are ordinary methods on a lifecycle meta object
that the daemon implements — a deployment fact, not a protocol special case.

### The object graph

Beyond instances, the daemon hosts meta objects. Data ownership and
relationships:

```
kernel ── hosts ──► directory (state)      join/leave feed
                 ├─► lifecycle (methods)   newInstance / killInstance
                 │                            └── creates instance objects
                 ├─► sessions (state)      session-file index (mtime cache)
                 └─► models (static read)  shared ModelRuntime catalog

instance #n ── method table: onUserMessage, setModel, setThinkingLevel,
               renameSession, navigate, switchSession, newSession, abort,
               discardSteer, listFiles, pull
             ── facets: log / state / transient
             ── subscriptions: Map<clientId, {facet, projection, lazy paths}>

client #m (client process) ── mirror + cache + wants-outbox + cursors
```

Client objects are not daemon-hosted — the kernel holds only their delivery
endpoint (the socket); the object itself lives in the client process.

- **Listing sessions** — the `sessions` meta object owns the session-file
  index (today's mtime-cached scan). State facet: `read()` returns the
  snapshot; change records replace v1's `sessions_changed` push. Live
  sessions are excluded by consulting the lifecycle object for live session
  ids (v1: the Daemon filtering Managers' `liveSessionId`).
- **Model list** — the `models` meta object is a static read over the shared
  `ModelRuntime`, stable for the daemon lifetime. Clients cache it for their
  connection lifetime, as today.
- **`listFiles`** — moves from a daemon verb to an instance method: its data
  (the instance cwd) is instance-scoped.
- **Subscription state lives in the instance object** —
  `Map<subscriberId, Subscription>` (facet + projection + subscribed lazy
  paths). This is where v1's per-Connection subscription set moves. A
  live-streaming subscription is a subscription to the transient facet;
  `pull` becomes an instance method whose subscription side effect is
  internal to the instance. GC follows v1 semantics: when a provisional
  entry commits, path filtering drops ops on the dead id; dead-client
  entries are inert until dispose. The client object owns the wants-outbox
  and the cursor cache; the kernel remembers nothing per subscription.

### Per-facet sync (duty moves into the objects)

Document sync logic (`applyPatch`, journals, projection) is **reused**, but
its duty moves: from the Daemon/Connection into the instance object. An
instance is composite — three facets, three sync contracts:

| Facet | Value | Sync | Retention |
|---|---|---|---|
| **Log** (committed entries) | large, append-only | `sync(cursor)` → replay tail | journaled |
| **State** (status: isStreaming, model, name, …) | small, mutable | `read()` → snapshot; push on change | latest-value only |
| **Transient** (streaming deltas, provisional skeletons) | ephemeral | live-subscription only | none |

Nothing is forced into a journal: the registry/directory is a state object
(no seq, no cursor — reconnect re-reads); only entry history pays for
cursors. The cursor need not be a synthetic counter — "last entry id seen"
is a natural cursor for an append-only log. In-flight content is never
journaled: a reconnect resumes from the log cursor and the in-flight entry
restarts from its skeleton (v1 behavior, preserved).

A client caches (e.g. IndexedDB) keyed by entry id + last cursor per stream;
the mirror becomes a local store + journal applier.

### Projections

An instance publishes once; delivery may be projected per subscriber
(summary vs. full document) so a dashboard costs O(1) per instance, not
O(tokens). Named profiles (`full`, `summary`, `metadata`) over the same
journal; exact set is an implementation decision.

## Alternatives considered

1. **Extend ADR 06 in place** — add an `instances_changed` push, allow
   multiple attachments per Connection, bolt a cursor onto `replace`.
   Rejected: attachment remains the routing primitive, so each goal
   (dashboard, cache, CLI client) lands as a new special case in the
   Connection's verb demux. This is the duct-tape path the goals exclude.
2. **Daemon-side hub with journals and projections** (an earlier draft of
   this ADR): addressed streams; a hub component owns journals, fan-out, and
   per-subscriber projection; the daemon routes. Rejected: it
   re-centralizes sync logic in the daemon — against the daemon/instance
   separation goal — and splits instance state from its sync machinery. The
   object kernel keeps the same machinery (journal, cursor, projection) but
   moves each piece into the object that owns the state.
3. **Uniform change-log objects** — plain `call`/`event` on objects with
   every event journaled and cursor-resumable. Rejected during review: it
   forces one-off state changes (the registry) into a change-log model where
   a re-read is cheaper than a replay. Hence the per-facet split — journals
   only where a client cache pays for them.

## Trust boundary

Two exceptions to "everything is trusted", both envelope-level:

1. **`_from` is stamped by the kernel, never sent.** The WS layer knows which
   socket owns which id. Without stamping, any client can impersonate any
   object.
2. **No client→client routing.** A static kernel rule: clients may address
   instance objects and meta objects only. Otherwise a client could call
   another client's `onPatch` and corrupt its mirror. The kernel stays
   payload-blind — the rule is on addresses, not content.

## The codec exception

v1's `CompactCodec` coalesces token-append patches into bare JSON strings —
payload-aware, so a type-blind kernel cannot host it. Resolution: the codec
sits on the pipe as an explicit **transparent transform**, per-connection,
stateful, free to coalesce — with one contract:

> The decoded message stream delivered to the recipient equals the stream the
> sender sent.

Same trust position as a compression layer: a buggy codec corrupts the pipe
(v1 already lives with this via its prime/reset rules), but it can never
invent or reorder semantics the sender didn't emit. No envelope changes, no
negotiation.

## What this replaces (at acceptance)

- **`Connection` as a protocol component** — dissolves into a WS adapter
  (delivery + validation + stamping) plus per-object subscription state.
- **Attach/detach, `switchInstance`** — a client subscribes to a different
  object and addresses its calls elsewhere. Routing collapses into
  lifecycle.
- **`replace` push** — snapshot = journal replay from cursor 0; resume =
  subscribe with a cursor.
- **Special push kinds** — `instance_exit` and `sessions_changed` become
  records/methods on ordinary objects (terminal record on the instance's own
  streams; directory change record).
- **Daemon document knowledge** — `listInstances` enrichment moves into the
  instance object (summary projection).
- **Verb demux buckets** — addressed calls replace the three-way switch.

## Invariant impact (ADR 06, restated)

| ADR 06 | Fate |
|---|---|
| §7.5 Manager callbacks are the only state channel | Becomes "messages are the only state channel" — objects communicate exclusively via envelopes; the test seam becomes record-sequence assertions on a peer |
| §7.10 reconnect replaces state wholesale | Becomes "reconnect = resubscribe": state objects re-read, log objects resume from cursor |
| §7.13 effects observed via push, not reply | Survives verbatim (notifications vs. replies) |
| §7.15 no hand-constructed wire frames | Survives — typed client/server stubs wrap the envelope |
| §7.7 laziness at the wire boundary | Survives — projection per subscription |
| §7.1–7.4, §7.9 (Document, Patch, pi drives the turn) | Untouched — core reuse |

## What becomes trivial

- **Out-of-process adapter** (deferred in ADR 06): any process that speaks
  the envelope and joins the directory is a peer — a jsonl-tail adapter
  exposing an existing pi session is just another instance object.
- **Non-web clients**: protocol = envelope schema + object method/record
  schemas, versioned, transport-injected; a CLI client is a thin peer.
- **Cross-tab instance sync**: directory change feed replaces polling.

## Implementation strategy

Build the new stack alongside v1 (new modules, same package), keep v1 green,
switch the web client in one commit. In-process strangler; the wire
coexistence question stays open (Open question 1).

### Local-wired TDD setup

Everything is in-process peers; the only I/O boundary is a transport
interface. No test needs a WebSocket:

- **`MemoryWire`** — a two-ended fake transport. Peers wired through it
  exchange the same envelopes as over WS, with enforced serialization
  fidelity (`JSON.parse(JSON.stringify(f))` round-trip — the
  `event-roundtrip.test.ts` discipline) and optionally the codec threaded
  in, so codec transparency is tested continuously, not at the end.
- **Recording test peer** — a peer that captures envelopes in/out;
  assertions are on message sequences.

### Port order

1. **Kernel** — directory, routing, stamping, no-client→client, liveness
   feed. Unit-tested standalone with in-memory endpoints.
2. **Meta objects** — directory/lifecycle/sessions/models on the kernel.
3. **Instance object** — wraps today's `createManager` internals. The
   fixture-resumed `SessionManager` + faux-provider harness carries over
   unchanged; existing Manager-callback tests port from `onPatch`
   assertions to recorded message sequences.
4. **Client object** — mirror behind the envelope. `client-mirror`,
   `bridge-client`, and `convergence` tests port; convergence becomes
   journal-replay ≡ live-projection.
5. **Web last** — store/infra swap `BridgeClient` for the new peer stub;
   UI untouched.

`core` is untouched — `applyEvent`/`applyPatch`/mirror pure functions and
their unit tests carry over as-is; only their callers move.

## Open questions

1. **Migration.** Hard cut to a v2 envelope vs. v1/v2 side-by-side on one
   daemon. Hard cut is cleaner; costs a coordinated client update. Not
   settled.
2. **Cursor durability across daemon restart.** In-memory resume only
   (snapshot fallback after restart), or derive durable cursors from the pi
   session file (append-only in the common case; `fork()` and version
   migration rewrite the file — see `SessionManager._rewriteFile` — so
   file-offset cursors are not universally stable; fork produces a new file,
   hence a new stream).
3. **Projection profile set.** `full`/`summary`/`metadata` vs. something
   richer.
4. **Id type and wire encoding.** Growing integers (compact) vs. strings.
5. **Whether the instance object stays in-process for v1 of this ADR** (the
   daemon hosts it directly) with the out-of-process form as a later proof.
