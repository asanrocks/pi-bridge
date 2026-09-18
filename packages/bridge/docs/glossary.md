# Glossary

The canonical reference for pi-bridge's coined vocabulary. Every term the
codebase and docs use with a project-specific meaning is defined here; terms
defined here are the only sanctioned coined names.

The vocabulary is deliberately small. It is split into three closed
**domains** — sub-dictionaries scoped to one concern — so that a reader (or a
contributor naming a new component) only needs the handful of words relevant
to that concern:

- **A. Addressing & lifetime** — what exists, how it is named, how long it lives.
- **B. Runtime topology** — which processes and links exist.
- **C. Document sync** — how session content travels.

## The naming rule

A coined name composes terms from **at most one domain**, plus generic
vocabulary. Cross-domain references use bare concept names, never compounds:
what crosses the wire at attach is *initial sync* (sync domain), not a
Connection–Mirror compound.

Mechanisms are not concepts. A domain's internals (pull queue, reconcile,
idle GC, …) are described inside their concept's entry or its ADR, using the
domain's words plus generic ones. They do not earn glossary entries and
should not leak into other domains' names.

## A. Addressing & lifetime

What exists, how it is named, how long it lives. Owned by
[ADR 11](11-adr-projects.md) (lifetime rules amended by
[ADR 12](12-adr-activation-lifetime.md), proposed).

| Concept | Definition |
|---|---|
| **Project** | A served directory; the address space for Sessions. Static daemon configuration, given as `--allow <[id=]dir>`. Its id is the validated last path segment; its session directory is the storage namespace. |
| **Session** | One conversation inside a Project. Addressed by `(projectId, stem)`, where *stem* is the session's jsonl path under the Project's session directory minus `.jsonl`. The durable `sessionId` is the cache key, not the address. |
| **Activation** | The live runtime for a Session — the thing with lifetime. Daemon-internal and never on the wire; "active" is Session *metadata* (an activation exists), not a wire object. Exactly one activation per session; never rebound to another session. |

## B. Runtime topology

Which processes and links exist. Owned by
[ADR 06](06-component-model.md) (instance-centric routing superseded by
ADR 11).

| Concept | Definition |
|---|---|
| **Daemon** | The server process: owns the Projects, the activation registry, and the Connections; serves the web client and the WebSocket protocol. |
| **Connection** | One client's link to the Daemon. Attached to at most one activation; the refcount unit of activation lifetime. |
| **Activation** | *(hinge, shared with domain A)* the Daemon's runtime for a Session. Implemented by the Manager (`src/host/manager.ts`); the two domains meet only through it. |

## C. Document sync

How Session content travels. Owned by [ADR 02](02-data-model.md) (Document,
entries, wire protocol) and [ADR 09](09-adr-incremental-sync.md) (cache,
cursor).

| Concept | Definition |
|---|---|
| **Document** | The canonical state of a Session's content: status + entry map, held by the activation. The Document is the session state machine clients sync to — not a raw event stream. |
| **Mirror** | The synchronized client-side replica of a Document (`DocumentMirror`). Same shape, fed by pushes. |
| **Entry** | One item in a Session — the unit of sync, persistence, and rendering. 11 variants, including the git-stamp custom entry. |
| **push** | Daemon-initiated wire delivery: `replace`/`patch` frames plus broadcasts (`sessions_changed`, `active_sessions_changed`). |
| **pull** | Client-initiated fetch of withheld content. A pull on an in-flight Entry is a live subscription; on a committed Entry it is one-shot. |
| **lazy / eager** | Wire delivery modes for fields. Lazy fields are withheld (`null`) on the wire and pulled on demand; eager fields always travel. Laziness is a wire projection — the canonical Document always holds real content. |
| **cursor** | How much of a Session a Mirror already has: the attach-time position enabling a delta initial sync instead of a full replace (`PrefixCursor`; `SessionListCursor` is the paginating list analogue). |

## The two seams

Two components legitimately span domains. They are sanctioned exceptions, not
precedents for crossing the naming rule:

- **Activation** (A ∩ B) — the hinge described above. All cross-domain
  sentences pass through it: "a Connection holds a refcount on an Activation",
  "an Activation serves a Session".
- **`BridgeClient`** (B ∩ C) — the client-side seam: typed RPC (topology)
  wrapped around a `DocumentMirror` (sync). It is the client's counterpart to
  the Activation's role of joining runtime to content.

## No domain: the projection layer and the web UI

- **`src/viewmodel/`** — projects sync-domain Documents into renderable
  structures (runs, groups, the history tree). It owns no coined glossary
  terms; its output types are compositions of generic words
  (`AssistantTurn`, `ActionGroup`, `ToolActionStep`).
- **`web/`** — owns no coined vocabulary at all. It composes domain concepts
  with generic UI words (card, drawer, toast, …). File-local implementation
  phrases are not glossary terms.

## Adding terms

Before coining a name, check whether it composes from one domain's concepts
plus generic vocabulary. If it does, use the composition — do not add a
glossary entry. If a genuinely new load-bearing concept appears (it must
matter on both sides of the wire, or redefine how a domain's components
relate), add it to its domain table here first, then name code after it.
