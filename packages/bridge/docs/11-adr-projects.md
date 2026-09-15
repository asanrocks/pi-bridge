# ADR 11: Projects, Sessions, Instances — Grounding the Domain Model

**Status:** Proposed. Introduces a domain layer above ADR 06's component model:
`Project` becomes a first-class concept, `Instance` is demoted to a transient
*activation*, and session identity is grounded in the archive file name
(`sessionId` stays the durable id; the **file stem** is the address). Amends
ADR 06 (routing verbs become project-scoped), plans invariants §7.19–7.24 for
`architecture.md`, and restructures the web sidebar. URL addressability is a
**consequence** of the corrected model, not its motivation — it is recorded in
§"Addressability falls out", after the model is settled.

## Context

### What exists today

- `--allow <dir>` populates `cwdAllowlist: string[]` (default
  `[process.cwd()]`). That list is the only notion of "the things this daemon
  serves".
- pi keeps one flat archive per cwd: `getDefaultSessionDir(cwd)` →
  `~/.pi/agent/sessions/--<cwd-slugged>--/`, read non-recursively, files named
  `<fileTimestamp>_<sessionId>.jsonl` where `sessionId` is a UUID.
- A `Manager` owns one pi runtime and one canonical Document, 1:1 with a
  session file. `Daemon.instances: Map<instanceId, Manager>` is the registry;
  `instanceId` is a `randomUUID()` minted at creation.
- `newInstance(cwd)` spawns a Manager; `switchInstance(instanceId, cursor)`
  rebinds a Connection; `switchSession(sessionPath, cursor)` repoints a live
  Manager to another file.
- `listSessions({ cwd, max, ts })` scans one archive and **filters out** ids
  held by live Managers (`getLiveSessionIds`).
- The web store keys everything on `attachedInstanceId`; the Sessions section
  is inert with no attached instance.

### The muddle

1. **Three concepts share one field.** `cwd` is at once a config entry, an
   archive namespace key, an instance attribute, and (today) the only
   human-facing address. There is no name for "the thing that owns an
   archive", so every place that needs one reaches for a filesystem path with
   four unrelated meanings.
2. **The instance is the only door.** Sessions are reachable only *through* a
   live instance: `listSessions` is scoped by `attachedManager?.cwd`, and the
   client passes the attached manager's cwd to `listFiles`/`readFile`. A
   project with no live instance is therefore invisible — its history is not
   merely unrendered, it is unrequestable.
3. **Instance identity leaks upward.** `instanceId` is the least durable
   object in the system (it dies with the process) yet it is the handle the
   UI, `listInstances`, `switchInstance`, `killInstance`, and any naive URL
   would use.
4. **Exclusivity is implicit.** "At most one live instance per session" holds
   today only because `listSessions` *hides* live ids from the picker.
   `switchSession` goes `Connection → attached Manager` and never consults the
   registry, so nothing prevents two Managers from loading the same file if it
   is addressed directly. Deep linking is exactly direct addressing — the
   feature that motivated this ADR turns a latent hole into a routine one.
5. **"Attach" is overloaded across two different bindings.** Today it means
   both *Connection → Instance* (transport binding, M:1, in
   `Connection.attach`) and, colloquially, *Session → Instance* (activation,
   1:1-at-a-time). Conflating them is why (4) went unnoticed: the exclusive
   relation was assumed to be the nonexclusive one.

This is a naming and ownership problem, not a feature gap. The fix is to name
the missing concept and re-ground the two that already exist.

## The model

```
Daemon                       process; owns static config + live registry
 │
 ├── Project "foo"           one --allow entry; owns exactly one archive namespace
 │    │                      identity: projectId (derived)  lifetime: daemon
 │    ├── Session S1         durable record: one jsonl file in the archive
 │    ├── Session S2         identity: sessionId (UUID)      lifetime: forever
 │    │                      address:  file stem (<timestamp>_<sessionId>)
 │    │
 │    └── Instance I1        transient activation of one session at a time
 │         │                 identity: instanceId (ephemeral) lifetime: process
 │         ├── Connection C1 client transport, attached
 │         └── Connection C2
 │
 └── Project "bar"
      └── Instance I2 ...
```

| Term | Definition | Identity | Lifetime |
|---|---|---|---|
| **Daemon** | The process. Owns the project configuration and the live registry. | — | process |
| **Project** | One `--allow` directory plus the session archive it owns. The unit of configuration and of history browsing. | `projectId` — derived, stable | daemon (config) |
| **Session** | One pi session file: a durable record in a project's archive, existing for the project's entire lifetime. | `sessionId` — UUID, immutable, in filename + header. Addressed by its **file stem**. | forever |
| **Instance** | A spawned pi runtime + canonical Document that activates one session at a time. An implementation mechanism, not an addressable entity. | `instanceId` — daemon-local UUID | process |
| **Connection** | One client transport. Attaches to at most one instance. | — | socket |
| **Session name** | Mutable display metadata (`status.name`, `renameSession`). Never an identity, never part of a path. | — | session |

There is deliberately no separate term for "a session while live": the live view
is an activated session, and the exclusivity rule is stated on the session.
Naming it (early drafts used `Conversation`) would add a word without adding an
identity, and would re-create exactly the ambiguity this ADR removes.

### Cardinality

| Relation | Cardinality | Notes |
|---|---|---|
| daemon → project | 1 : N | Static config. N ≥ 1 (a daemon with no project serves nothing). |
| project → session | 1 : N | Sessions never migrate between projects. |
| session → live instance (activation) | ≤ 1 | **The exclusivity invariant.** |
| instance → session (at a time) | 1 : 1 | Repointable: `switchSession` moves the activation. Not a permanent binding. |
| instance → connection (attachment) | 1 : N | Fan-out to many viewers. |
| connection → instance | ≤ 1 | Existing `attach`/`detach` contract. |

### Identity rules

- **`projectId` is derived, validated, and unique.** Last path segment of the
  allowlisted directory (`/path/to/foo` → `foo`), normalized and checked
  against a reserved charset. The daemon **rejects startup** on any duplicate
  id, invalid segment, or archive-key collision (see Decision 10) — a
  URL-addressable id must be unambiguous, and silent suffixing (`foo-2`) would
  encode registration order into a shared link.
- **`sessionId` is the durable session identity.** It is a UUID, it is in the
  filename, and it survives renames (`renameSession` touches header metadata
  only). It is the key for cursors and cache (ADR 09) and for deduplicating
  live activations.
- **The session *address* is the jsonl file stem** — the filename without
  `.jsonl` (`<fileTimestamp>_<sessionId>`). pi names the file by timestamp plus
  id, so the id alone does **not** locate a file: mapping `sessionId → path`
  requires scanning the archive, while mapping `stem → path` is a direct
  `join(archiveDir, stem + ".jsonl")`. The stem is unique within a project's
  archive by construction, is URL-safe (its charset is exactly what pi's
  session-id validation permits), and is stable across renames. Addresses use
  the stem; durable records and caches use the id. Where both are needed the
  stem's suffix *is* the id.
- **`instanceId` is never durable, never user-facing, and never in a URL.**
  It remains the in-memory registry key.

## Decisions

1. **Project becomes a first-class domain concept**, derived from `--allow`.
   It is what owns an archive, what `getDaemonInfo` reports, and what the
   client navigates by. `cwdAllowlist: string[]` is replaced by
   `projects: { id, cwd }[]` in the daemon's public surface.

2. **`projectId` = last path segment**, validated, unique across the daemon.
   Startup fails on duplicates or invalid segments (`.`/`..`/empty, characters
   that cannot appear in a URL path unescaped). An explicit `--allow
   id=path` form is the escape hatch for deliberately aliased or colliding
   basenames; it is sugar over the same field, not a second mechanism.

3. **The project owns the session archive, but pi keeps the archive key.**
   Two namespaces exist and must be mapped, not merged: bridge's `projectId`
   (short, URL-facing, bridge-owned) and pi's encoded-cwd archive directory
   (`~/.pi/agent/sessions/--<cwd-slugged>--`, path-derived, pi-owned). The
   daemon holds the single mapping `projectId → cwd → archive dir`. Bridge
   MUST NOT re-derive archive paths from `projectId`.

4. **A session is addressed by its archive file stem; `sessionId` remains the
   durable id; the display name never addresses anything.** Addresses,
   cursors (ADR 09), and cache keys split accordingly: the URL and the
   resolve path use the stem (direct file mapping), durable records and
   dedup use the id. Any user-visible label (`status.name`, first-message
   text) is presentation only.

5. **Instance is an activation, not an entity of interest.** It exists to make
   one session chat-able. It is not addressable by clients, not reported as a
   durable identity, and not a term in the URL space. `listInstances` remains
   as a liveness view (its payload gains `projectId`), but nothing attaches
   *by* instance except the Connection contract.

6. **Exclusivity is enforced at resolution, not by filtering.** "At most one
   live instance per session" becomes a guard on the activation path, in the
   only component that can see the whole registry: the daemon. `listSessions`
   hiding live ids is retained as defense-in-depth for the picker, not as the
   mechanism.

7. **Addressability is `(projectId, sessionStem)`.** A single daemon verb
   resolves it:

   ```
   openSession(projectId, stem, cursor?) → { instanceId, created: boolean } | { error }
     live instance holds that session             → reuse it (attach there)
     join(archiveDir, stem + ".jsonl") exists      → create an instance, activate
     otherwise                                    → not found (no cross-project revive)
   ```

   Resolution is scoped by project, and the dormant branch is a direct path
   join — no directory scan, no header parse. The live branch matches the
   instance whose current session file stem (or, before its first flush, whose
   `liveSessionId` — the stem's suffix) equals the request. A stem that exists
   under a different project is *not found* here, never revived.

8. **Client attach becomes resolve-and-attach.** The client's current
   `newInstance → listSessions → switchSession` sequence (in
   `useConnection.initDaemonInfo` and `useRpc`) moves server-side into
   `openSession`. Instance creation stops being a client concern; the client
   names a session and the daemon decides what must exist.

9. **Wire surface changes** (ADR 06 §"Verb contracts" amended):

   | Change | Shape |
   |---|---|
   | `getDaemonInfo` | `projects: { id, cwd }[]` (replaces `cwdAllowlist`) |
   | `InstanceInfo` | `+ projectId` (instanceId retained for the attach contract) |
   | `SessionInfo` | `+ projectId`, `+ stem` (the address; derivable from `sessionPath` but kept explicit so the client never parses paths) |
   | new verb | `openSession(projectId, stem, cursor?) → { instanceId, created }` |
   | `newInstance` | re-scoped to `(projectId)` or subsumed by `openSession` with a null stem (fresh session) |
   | `switchSession` | gains the exclusivity guard (consult registry before repointing a live Manager) |
   | `listSessions` | scoped by `projectId` instead of an ambient attached cwd |

10. **Archive-key collisions are rejected, not tolerated.**
    `getDefaultSessionDir`'s encoding is lossy: `/a/b-c` and `/a/b/c` both slug
    to `--a-b-c--`, so two allowlisted projects would share one archive and a
    session would descend from two projects — breaking the model's own axiom
    (§Cardinality) and corrupting exclusivity. The daemon computes archive keys
    at startup and rejects collisions. (Fixing the upstream encoding is an
    orthogonal pi concern; bridge must not depend on it.)

## Addressability falls out

Given Decisions 1–7, the URL is a pure function of `(projectId, sessionStem)`
— there is nothing new to invent. The scheme is short and flat, and reuses the
name the client already has for the unattached view:

```
/launcher                    → project list (the Launcher; today's attachedInstanceId === null view)
/chat/<project>              → one project's session list (optional; the sidebar already browses this)
/chat/<project>/<stem>       → the session (resolve → attach or activate)
```

| Store/URL fact | Value |
|---|---|
| Opens the same session for a colleague | Yes — a durable file stem, not the process-local instance |
| Survives daemon restart | Yes — resolution falls to the dormant branch |
| Survives rename | Yes — names are not addresses (Decision 4) |
| Resolvable without a scan | Yes — the stem *is* the archive filename, so dormant resolution is one `join` + `existsSync` |
| Backed by | `openSession` (Decision 7); no per-link server state |

Because the paths are real paths (not `#` fragments), the daemon's HTTP server
needs an SPA fallback: today unknown paths `404` in both embedded and
`--web-root` modes, so `/launcher` and `/chat/*` MUST serve `index.html`.
Unknown-asset-vs-unknown-route is the usual extension heuristic. There is no
server-side content for these routes; the fallback is the whole mechanism.

Write side: the URL is written on attach (when the session file stem is known)
and on project navigation; `/launcher` replaces today's `launcherPinned` flag
as the unattached state; `instance_exit` and explicit detach rewrite it. Boot
reads it; in-app navigation writes it. Three properties keep it a side effect
rather than a second source of truth:

- **It is derived state, never consulted during a running session.** The store
  remains authoritative; the URL mirrors it. A mismatch cannot exist because
  nothing reads the URL after boot. (`popstate`/live handling is a later
  option, not part of this decision.)
- **`replaceState`-only in v1**, so the URL is a live permalink and does not
  introduce a second navigation model competing with the sidebar/history pane.
  Back-button navigation is a separate decision.
- **A brand-new session has no address yet.** `sessionId` exists at
  construction, but the stem requires a filename, which requires the first
  flush (ADR 09's live stub has `sessionPath: null`). Until then the URL stays
  at `/chat/<project>`; this makes the address *durable by construction* —
  anything addressable can be reopened — at the cost of an unaddressable first
  turn.

The one behavior this changes: a URL is honored over the reconnect auto-attach
heuristics (`launcherPinned`, T1 sole-instance resume). Explicit intent beats a
convenience default.

## Consequences for the client: the sidebar becomes a project browser

The URL is not the only thing the corrected model restructures. Today's
sidebar is `attachedInstanceId`-shaped in a way the model no longer justifies:

| Today | Why it no longer fits |
|---|---|
| Section **Instances** (live) | An instance is now an internal mechanism. Listing instances asks the user to choose a process, not a session. |
| Section **Sessions** (dormant) | Scoped to the attached instance's cwd (`listSessions` needs `attachedManager?.cwd`), so it shows one project and only while something is live in it. |
| Sessions disabled with no instance | Dormant projects are unreachable — the exact defect §Context 2 names. |
| Flat lists, no hierarchy | Projects are the ownership boundary of both config and history; the sidebar renders neither. |

The restructure: **projects are folders, sessions are their items.**

```
▾ foo                               ● 2 live
    ▸ 2026-07-21T10-00-00-000Z_3f2a…  ● streaming
    ▸ 2026-07-20T18-04-11-000Z_91cd…
▾ bar
    ▸ 2026-07-19T09-12-00-000Z_77ab…  ● idle
```

Consequences:

- Liveness becomes a per-session attribute (a dot/streaming badge), not a
  grouping. The Instances section disappears as a user-facing concept; which
  processes exist is an implementation detail, surfaced at most as a count.
- Every project is browsable with zero live instances — the archive is the
  primary object (sessions fetched by `projectId`, not by an attached cwd).
- Selecting an item is exactly `openSession` — the same operation the URL
  resolves to, so the sidebar and a shared link are the same code path.
- The Launcher (`/launcher`) shows the same project/session tree at full width
  plus the connection down-state panels; it is no longer an *instance* picker.
- The header's "back to instance list" button added for detach now targets
  `/launcher` — the same state the URL names.
- The store keeps `attachedInstanceId` as the transport binding, but gains
  project/session navigation state (`expandedProjects`, selected project) and
  loses `instances` as a first-class list rendered in the rail.

This is a larger UI PR than the protocol work and must amend `docs/04-prd-web-ui.md`
(whose "Instances + Sessions" sidebar is now wrong). It is recorded here
because it follows from the model, not because it can ride along with
`openSession`.

## Exclusivity: the guard and its placement

The guard must sit where the registry is visible, and only there:

- **Placement.** In the daemon, on the activation path (`openSession` and
  `switchSession`). `Connection` cannot see other Connections' Managers; a
  `Manager` cannot see the registry at all. Any guard in either is a racy
  approximation.
- **Conflict resolution is reattach, not rejection.** If the target session is
  already activated, the daemon attaches the caller to the *existing* instance.
  A second browser tab or a shared link therefore joins the session instead of
  forking a second writer onto one jsonl. Rejection (`409`) is reserved for the
  case where a caller explicitly asks to *become* the writer, which no current
  verb does.
- **Races.** Two `openSession` calls for the same dormant stem can both pass a
  "no live instance" check before either mints one. The daemon serializes
  activation per session (the registry map is in-process and the
  check-then-create is synchronous up to the factory call), so the second
  caller observes the first's instance. No cross-process hazard exists while
  one daemon owns an archive.
- **Defense-in-depth.** `listSessions` keeps hiding live ids so a client
  cannot even offer a live session as a picker target.

## Alternatives considered

- **URL carries `instanceId`.** Simplest to wire (the registry key already
  exists) and rejected: the id dies with the daemon, so links rot on restart;
  it names the mechanism instead of the thing the user means; and sharing a
  link would target a specific process rather than a session.
- **Address sessions by `sessionId` (UUID) rather than the file stem.**
  Rejected: pi names files `<fileTimestamp>_<sessionId>.jsonl`, so the id is
  not the filename — mapping id → file needs a scan (or a glob) of the
  archive, while the stem is a direct `join`. The stem also carries the
  creation timestamp, which makes a shared link self-describing. The id keeps
  its job as the durable identity for cursors, caches, and dedup; the two are
  connected by the filename (the stem's suffix *is* the id).
- **URL carries `sessionId` only, no project segment.** Session ids are
  globally unique, so lookup is possible without the project. Rejected as the
  *canonical* form because it forces a cross-project scan (or a global index)
  to resolve, and because it makes cross-project mistakes invisible: a link
  carrying the wrong project should fail loudly, not silently revive from
  wherever the id happens to live. Project scoping is cheap because the
  mapping (Decision 3) is direct.- **Project as a client-side slug of cwd.** Keeps the daemon unchanged.
  Rejected: the uniqueness rule, the collision check, and the id→cwd mapping
  are all daemon-owned facts. A client re-deriving them would duplicate the
  policy and could not enforce uniqueness at startup.
- **URL carries the encoded cwd path.** Human-readable and no new concept.
  Rejected: it is pi's lossy archive encoding (Decision 10), it exposes
  filesystem layout to links, it makes the URL long, and it hardcodes a
  storage detail into the address space.
- **Explicit `--allow id=path` only, no derivation.** Maximal clarity, no
  collisions by construction. Rejected as the default because the common case
  (`--allow ~/src/foo` → `foo`) needs no ceremony; retained as the escape
  hatch (Decision 2).
- **Permanent instance↔session binding.** Makes exclusivity structural
  (an instance *is* an activation for life) but forces a process spawn per
  session switch; repointing is cheaper and the guard (Decision 6) gives
  the same guarantee. This is exactly the ambiguity in "an instance activates
  one session" that the model must state as *at a time*.
- **Keep `cwd` as the term, add no Project.** Least churn. Rejected: the
  invisible-dormant-project problem (§Context 2) is not a missing feature but
  a missing concept, and a path cannot be the address once the URL must be
  stable across cwd moves, short in a link, and unique per daemon.

## Invariants

Planned additions to `architecture.md` §7 (numbers provisional until
acceptance):

19. **A project owns exactly one archive; a session descends from exactly one
    project.** Archive-key collisions are a startup error (Decision 10).
20. **`projectId` is unique per daemon, derived, and stable for the daemon's
    life.** Duplicates and invalid segments are startup errors.
21. **`sessionId` is the only durable session identity; the archive file stem
    is the only session address.** Display names are metadata and never
    address anything. The stem's suffix is the id.
22. **At most one live instance per session; activation is exclusive and
    guarded at the daemon.** Reattachment, not duplication, is the conflict
    resolution.
23. **`instanceId` is ephemeral and internal.** It never appears in an
    address, a cache key, or a durable record.
24. **The URL is derived state.** Written from the store, read only at boot;
    no behavior depends on it during a session.

## Open questions

- **Orphan sessions.** An archive can outlive its project (cwd removed from
  `--allow`, or the directory deleted). Options: hide orphans, surface them in
  the landing page as unmanaged, or offer re-registration. The model says they
  descend from no project; the UX is undecided.
- **Transient first-turn URL.** A session with no file yet (pre-flush) has no
  stem, so the URL stays at `/chat/<project>` until the first persist. Whether
  that intermediate URL is a supported route or an internal state is undecided.
- **Stem stability under file rename.** The address is the filename, so it is
  only stable while pi never renames an existing session file. pi mints a new
  file (and id) for a new session, so this holds today; if a fork/rollover
  ever renames in place, URLs rot and the id suffix becomes the fallback
  resolver. Worth confirming with pi before depending on it.
- **Project page scope.** Full archive with paging, or a recent-N window? The
  archive can be large; this interacts with ADR 09's cache keyed by session.
- **Runtime project management.** Adding a project after startup (CLI verb,
  RPC) would make the registry mutable and `projectId` uniqueness a runtime
  check. Out of scope for v1 (config is static), but the id rules should not
  preclude it.
- **Multiple daemons over one archive.** Two daemons with different
  `projectId`s pointing at one cwd would each enforce exclusivity over their
  own registry and write one jsonl from two processes. Today's posture assumes
  a single daemon; if that assumption weakens, exclusivity needs a file-level
  lock, not a registry check.

## Test plan

- **Daemon unit** — `projectId` derivation (last segment, normalization, case);
  startup rejection for duplicates, invalid segments, and archive-key
  collisions (`/a/b-c` vs `/a/b/c`).
- **`openSession` matrix** — live stem (reattach, `created: false`); dormant
  stem (create + activate, `created: true`); unknown stem (not found); stem
  from another project (not found — no cross-project revive); stem whose
  suffix matches a live but unflushed instance (live branch).
- **Stem → file mapping** — a dormant resolve touches exactly one path
  (`join(archive, stem + ".jsonl")`), with no `readdir`/scan.
- **Exclusivity** — two Connections opening the same session land on one
  instance; a direct `switchSession` to a live session in another instance is
  reattached/refused rather than double-bound.
- **Daemon HTTP** — `/launcher` and `/chat/*` serve `index.html` (SPA
  fallback) while unknown assets still `404`.
- **Pure URL module** — parse/serialize for `/launcher`, `/chat/<project>`,
  `/chat/<project>/<stem>`; unknown or malformed segments, project/stem
  mismatch.
- **Store** — landing vs project vs session state transitions; `/launcher`
  replaces the pin semantics (URL wins over auto-attach on boot).
- **Integration** — cold open of a session URL against a fixture-resumed
  daemon (dormant branch), and against a live one (reattach branch), driven
  through the full Manager + faux-provider stack.

## Relationship to other ADRs

- **ADR 02 (data model)** — unchanged. A session remains an append-only
  ordered log; this ADR only says who owns it.
- **ADR 06 (component model)** — amended. Routing verbs become project-scoped;
  `InstanceInfo` gains `projectId`; the Daemon gains `openSession` and the
  exclusivity guard. The Instance and Connection contracts are otherwise
  untouched.
- **ADR 07 (client architecture)** — the store's `attachedInstanceId` stays as
  the transport binding, but the *user-facing* unit becomes the session; the
  URL is a derived projection of that store, not a new source of truth. The
  sidebar restructure (§Consequences) supersedes ADR 07's two-section rail.
- **ADR 08 (object kernel, Proposed)** — Projects and Sessions are natural
  objects in that model (Project = directory + registry, Session = Log facet).
  This ADR does not depend on it; if ADR 08 lands, `openSession` becomes a
  directory-level resolution.
- **ADR 09 (incremental sync)** — unaffected. Cursors are keyed by
  `sessionId`; the project segment only scopes lookup, and the cache key is
  unchanged.
- **ADR 10 (git stamps)** — unaffected.
- **PRD 04 (web UI)** — amended. Its "Instances + Sessions" sidebar and
  instance-centric Launcher are replaced by the project browser
  (§Consequences); the URL space is added.
