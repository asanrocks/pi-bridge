# Glossary

The canonical reference for pi-bridge's vocabulary. Terms are defined by the
**claims** of the domain they belong to — a term means what the claims say
about how it composes, and may only be used where a claim licenses it.

## The cost model

Vocabulary follows a compression trade-off:

- A **coined term** (activation, cursor, spine) is expensive: the reader pays
  a learning cost once, and a disambiguation cost on every use.
- **Common vocabulary** (step, chip, group) is free.
- A **composition** — existing terms plus common words ("action group",
  "initial sync") — is free.

A coined term earns its place only when all hold:

1. It is used often enough that the phrase it replaces would cost more
   (roughly: it recurs across modules or spec documents, not one file).
2. It does not collide with a generic word used in another sense (a term
   that shadows an ordinary verb pays disambiguation on every use).
3. It cannot be expressed as a composition of existing terms and common
   words.

Terms that fail this are written as phrases and may not be coined in code
names. The same test demotes a term whose usage decays.

## The naming rule

A coined name composes terms from **at most one domain**, plus common
vocabulary. Cross-domain references use bare concept names, never compounds:
what crosses the wire at attach is *initial sync* (sync domain), not a
Connection–Mirror compound.

## A. Addressing & lifetime

What exists, how it is named, how long it lives. Owned by
[ADR 11](11-adr-projects.md); lifetime amendments proposed by
[ADR 12](12-adr-activation-lifetime.md).

1. A **Project** is a served directory; it is the address space for Sessions.
   Its id is the validated last path segment; its session directory is the
   storage namespace.
2. A **Session** is one conversation inside a Project.
3. A Session is addressed by `(project, stem)`. The **stem** is the
   session's jsonl path under the Project's session directory minus
   `.jsonl`; the durable `sessionId` is the cache key, not the address.
4. An **Activation** is the live runtime of exactly one Session. It is
   daemon-internal and never on the wire: "active" is Session metadata, not
   a wire object.
5. An Activation is created by opening a Session and is never rebound to
   another Session.
6. An Activation is kept alive by its attached Connections and by streaming
   or compaction in progress; when none apply it is idle-collected. A
   Session with no Activation is dormant.
7. *(ADR 12, proposed.)* A prompt is **admitted** when the Daemon accepts it
   but it is not yet observable in the Document; admitted prompts and
   in-flight user commands form the in-flight window that also keeps an
   Activation alive. An Activation claimed by a session switch is a
   **reservation** until the switch commits.

## B. Runtime topology

Which processes and links exist. Owned by
[ADR 06](06-component-model.md), as amended by ADR 11.

1. A **Daemon** is the server process: it owns the Projects, the activation
   registry, and the Connections.
2. A **Connection** is one client's link to the Daemon.
3. A Connection is attached to at most one Activation.
4. An Activation is implemented by a Manager.
5. A **verb** is an RPC request type. Verbs are session, navigation, or
   query verbs.
6. A Connection processes verbs on its **lane**: one verb at a time, in
   order.

## C. Document sync

How Session content travels. Owned by [ADR 02](02-data-model.md) (Document,
wire protocol) and [ADR 09](09-adr-incremental-sync.md) (cache, cursor).

1. A **Document** is the canonical content of a Session: status plus entry
   map. Clients sync to a Document, not to an event stream.
2. An **Entry** is one item in a Session: the unit of sync, persistence, and
   rendering.
3. An Entry is **committed** or **provisional**; provisional identity is
   mutable until the turn ends.
4. **Reconcile** aligns the Document with the durable entries; it runs at
   the **seal** (turn end, settle) and on idle-state verbs.
5. A **Mirror** is the synchronized client-side replica of a Document.
6. Entry fields are **lazy** or **eager**. Lazy fields are withheld on the
   wire and fetched on demand; the canonical Document always holds real
   content. Text is eager; thinking, tool arguments, and tool results are
   lazy.
7. A **pull** fetches withheld content: on a provisional Entry it is a live
   subscription that streams until commit; on a committed Entry it is
   one-shot. A Mirror declares its demand as **wants**, drained by the pull
   loop.
8. A **push** is daemon-initiated delivery: `replace` or `patch` frames,
   plus broadcasts.
9. A **cursor** records how much of a Session a Mirror already holds. At
   attach it yields the **initial sync**: a patch when the cursor validates,
   a full replace otherwise.
10. A **git stamp** is a custom Entry recording a git identity transition;
    its **anchor** names the observation boundary.

## D. Rendering

How a Document becomes UI. Owned by [ADR 07](07-adr-client-architecture.md)
and [PRD 04](04-prd-web-ui.md); spans `src/viewmodel/` and `web/`.

1. A **ViewModel** is the projection of a Document into renderable form.
2. The ViewModel is a tree of **turns**; each root-to-leaf path is a
   conversation branch.
3. A **turn** is one node of that tree and is composed of one or more
   entries. A user turn is one entry; an assistant turn merges consecutive
   assistant entries. Turns are user, assistant, system, user-bash, or
   git-change.
4. Inside an assistant turn, consecutive tool and thinking blocks become an
   **action group**; text blocks never join a group.
5. A **step** is a member of an action group: a tool call/result pair, or
   thinking content.
6. A step has a **kind** — read, write, edit, bash, think — and kinds map to
   **families** — read, bash, think, mutate — which carry color.
7. A step renders in one of two modes: **folded** (summary line) or
   **expanded** (full content). Expanded steps stay expanded across
   re-renders while streaming.
8. The steps of a group share a vertical **spine**; the group header
   carries the family dots.
9. An expanded step renders its body as a **card**.
10. A git stamp renders as a **mark** in the spine after the step it
    follows, or as a standalone turn when no group is open.
11. A **band** is the tinted row that renders a turn or action, carrying
    its family color.
12. Shell command segments in a folded step's summary render as **chips**.
13. A **draft** is the composer's unsent text. Drafts are client state, not
    daemon objects.

## The seams

Two components legitimately span domains; they are sanctioned exceptions,
not precedents:

- **Activation** (A ∩ B) — the hinge. All cross-domain sentences pass
  through it: "a Connection holds a refcount on an Activation", "an
  Activation serves a Session".
- **`BridgeClient`** (B ∩ C) — the client-side seam: typed RPC (topology)
  wrapped around a `DocumentMirror` (sync).

The ViewModel is the C → D seam: it projects a Document, and everything
below it composes rendering-domain terms only.
