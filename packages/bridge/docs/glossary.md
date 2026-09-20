# Glossary

Canonical vocabulary reference for pi-bridge — the specification of the
intended vocabulary, not a report of current code. Normative: a term means
what the claims of its domain say, and may only be used where a claim
licenses it. Identifiers and prose follow the claims.

This document describes the ultimate vocabulary. It carries no process
state.

## Tiers

Words are paid for at three rates:

- **Coined** — a word pi-bridge gives a new meaning (activation, seal, git
  stamp). Expensive: the reader pays a learning cost once, and a
  disambiguation cost on every use. The coined budget is **three**; a fourth
  requires amending this document and passing all criteria below.
- **Bound** — an established word bound to a precise local meaning (mirror,
  cursor, reconcile, turn). Cheap: one sentence pays for it; the reader
  brings the word, we supply only the claim.
- **Composed** — existing terms plus common words ("action group", "initial
  sync"). Free.

A coined term must pass all of:

1. It recurs across modules or spec documents, not one file.
2. It does not collide with a generic word used in another sense.
3. It cannot be expressed as a composition of existing terms and common
   words.

A term that fails is written as a phrase and may not be coined in code names.

## Naming rule

A coined name composes terms from **at most one domain**, plus common
vocabulary. Cross-domain references use bare concept names, never compounds:
what crosses the wire at attach is *initial sync* (sync domain), not a
Connection–Mirror compound.

**Retired words** were coined, audited, and demoted. They may not be coined
again; use the phrase given:

| Retired | Use instead |
| --- | --- |
| project (verb) | "a projection of …" |
| identity (outside git) | "header" / "title" |
| spine | "the group's vertical line"; history tree: "active path" |
| band | "tinted row" |
| mark | "renders inline after the action it follows" |
| fold (abbreviation) | "elide" |
| swatch | "kind-colored dot" |
| family | "hue" ("kinds share a hue") |
| lane | describe the serialization in words |
| wants | "pending pulls" |

One code-local name is a sanctioned exception: **`LaneLayout`**
(`src/viewmodel/tree.ts`), the history tree's layout, where a *lane* is a
vertical track a child inherits from its parent. The sense is
rendering-local, distinct from the retired topology "lane", and may not
be used in code names outside the history tree.

## A. Addressing & lifetime

What exists, how it is named, how long it lives. Owned by
[host runtime](host/runtime.md); proposed lifetime changes are recorded in
[ADR 12](adr/0012-activation-lifetime.md).

1. A **Project** *(bound)* is a served directory; it is the address space
   for Sessions. Its id is the validated last path segment; its session
   directory is the storage namespace.
2. A **Session** *(bound, pi)* is one conversation inside a Project.
3. A Session is addressed by `(project, stem)`. The **stem** *(bound, path
   stem)* is the session's jsonl path under the Project's session directory
   minus `.jsonl`; the durable `sessionId` is the cache key, not the address.
4. An **Activation** *(coined)* is the live runtime of exactly one Session.
   It is daemon-internal and never on the wire: "active" is Session
   metadata, not a wire object.
5. An Activation is created by opening a Session and is never rebound to
   another Session.
6. An Activation is kept alive by its attached Connections and by streaming
   or compaction in progress; when none apply it is idle-collected. (The
   rule is stable; the mechanism is not — ADR 11 implements it with idle
   timers, ADR 12 proposes event boundaries.) A Session with no Activation
   is dormant.

ADR 12 proposes further lifetime vocabulary (admitted prompt, reservation,
in-flight window). It is ADR-local until that ADR is accepted; this document
does not claim it.

## B. Runtime topology

Which processes and links exist. Defined by [host runtime](host/runtime.md)
and [core protocol](core/protocol.md).

1. A **Daemon** *(bound)* is the server process: it owns the Projects, the
   activation registry, and the Connections.
2. A **Connection** *(bound)* is one client's link to the Daemon.
3. A Connection is attached to at most one Activation.
4. An Activation is implemented by a Manager *(bound)*.
5. A **verb** *(bound, after HTTP)* is an RPC request type. Verbs are
   session, navigation, or query verbs.
6. A Connection demultiplexes verbs: attached Session verbs route to its
   Manager, daemon verbs route to the Daemon, and `pull` is Connection-local.
   Each handler owns its asynchronous work and replies through the same
   Connection.

## C. Document sync

How Session content travels. Defined by the [core data model](core/data-model.md),
[core protocol](core/protocol.md), and [incremental sync](core/sync.md).

1. A **Document** *(bound)* is the canonical content of a Session: status
   plus entry map. Clients sync to a Document, not to an event stream.
2. An **Entry** *(bound)* is one item in a Session: the unit of sync,
   persistence, and rendering.
3. An Entry is **committed** *(bound)* or **provisional** *(bound)*;
   provisional identity is mutable until it is sealed.
4. **Reconcile** *(bound)* aligns the Document with the durable entries; it
   runs at **settle** *(bound)* — the end of a turn, when streaming stops —
   and on idle-state verbs. Reconcile **seals** *(coined)* provisional
   entries: each provisional id is replaced by its durable id, emitted as a
   `move` op. Settle is the event; sealing is the identity transition at that
   event. `sealed` and `seal timestamp` name the resulting state, so "on
   seal" means "when the entry is sealed" — never a second event.
5. A **Mirror** *(bound)* is the synchronized client-side replica of a
   Document.
6. Entry fields are **lazy** *(bound)* or **eager** *(bound)*. Lazy fields
   are withheld on the wire and fetched on demand; the canonical Document
   always holds real content. Text is eager; thinking, tool arguments, and
   tool results are lazy.
7. A **pull** *(bound)* fetches withheld content: on a provisional Entry it
   is a live subscription that streams until commit; on a committed Entry
   it is one-shot. A Mirror declares its demand as **pending pulls**
   *(composed)*, drained by the pull loop.
8. A **push** *(bound)* is daemon-initiated delivery: `replace` or `patch`
   frames, plus broadcasts.
9. A **cursor** *(bound)* records how much of a Session a Mirror already
   holds. At attach it yields the **initial sync** *(composed)*: a patch
   when the cursor validates, a full replace otherwise.
10. A **git stamp** *(coined)* is a custom Entry recording a git identity
    transition; its **anchor** *(bound)* names the observation boundary
    (prompt, tool end, turn end, user bash end). The **identity** *(bound)*
    is the `{commit, branch}` pair — "identity" is reserved to this git
    sense and may not be reused for card headers or titles.

## D. Rendering

How a Document becomes UI. Defined by [web architecture](web/architecture.md)
and [web design](web/design.md).

1. A **ViewModel** *(bound, MVVM)* is the projection of a Document into
   renderable form.
2. The ViewModel is a tree of **turns** *(bound, pi)*; each root-to-leaf
   path is a conversation branch.
3. A turn is one node of that tree and is composed of one or more entries.
   A user turn is one entry; an **assistant turn** merges consecutive
   assistant entries. Turns are user, assistant, system, user-bash, or
   git-change.
4. Inside an assistant turn, consecutive tool and thinking blocks become an
   **action group** *(composed)*; text blocks never join a group.
5. A member of an action group is an **action** *(common word)*: a tool
   call/result pair, or thinking content.
6. An action has a **kind** *(common word)* — read, write, edit, bash,
   think. Kinds share a hue: write and edit share the mutate hue.
7. An action renders **collapsed** *(bound)* (summary line) or **expanded**
   *(bound)* (full content). An expanded action is **frozen** *(bound)*: it
   stays expanded across re-renders while streaming.
8. The actions of a group render along a shared vertical line; the group
   header carries one kind-colored dot per kind present.
9. An expanded action renders its body as a **card** *(bound)*. Shell
   command segments in a collapsed action's summary render as **chips**
   *(bound)*.
10. A git stamp inside a group renders inline after the action it follows,
    as a card; with no group open it renders as a standalone turn.
11. A turn renders as a tinted row carrying its hue.
12. A **draft** *(bound)* is the composer's unsent text. Drafts are client
    state, not daemon objects.

## The seams

Two components legitimately span domains; they are sanctioned exceptions,
not precedents:

- **Activation** (A ∩ B) — the hinge. All cross-domain sentences pass
  through it: "a Connection attaches to an Activation", "an Activation serves
  a Session", and the Daemon tracks which Connections are attached.
- **`BridgeClient`** (B ∩ C) — the client-side seam: typed RPC (topology)
  wrapped around a `DocumentMirror` (sync).

The ViewModel is the C → D seam: it projects a Document, and everything
below it composes rendering-domain terms only.

