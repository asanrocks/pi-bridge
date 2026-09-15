# ADR 11: Projects and Sessions

**Status:** Proposed. Reworks the daemon's session domain model and the client
protocol around two client-facing concepts: a static `Project` configuration
and a `Session`. Sessions are addressed by `(projectId, stem)`. A session may
be *active* (the daemon holds a live runtime and canonical Document for it)
and carries that as metadata. The activation itself — the runtime object, its
lifecycle, and its identifier — is an internal daemon implementation detail
and never appears on the wire.

This ADR does not introduce project archival, project migration, or a generic
object-kernel protocol. It keeps pi's existing session storage and the bridge's
Document sync model, while replacing the instance-centric navigation surface.

## Context

### Current implementation

The current bridge has these properties:

- `--allow <dir>` supplies a flat cwd allowlist.
- `Daemon.instances` is a `Map<instanceId, Manager>`.
- An `Instance` is a pi runtime and canonical Document bound to one session at a
time.
- A `Connection` attaches to one instance.
- `switchSession(sessionPath)` is routed to the attached Manager. Rebinding a
  Manager changes the Document for every Connection attached to it.
- `listSessions` scans pi's cwd-derived session directory, returns file paths,
  and filters live sessions out of the listing.
- Reconnect resumes an `instanceId`, not a durable session address.
- The web cache is keyed by `sessionId`, but the UI navigates with
  `instanceId` and `sessionPath`.

Pi creates a session's intended filename when `SessionManager.newSession()` is
called, before the first assistant response flushes the file. Thus an
unflushed session can have a known provisional stem even though it is not yet
durable.

### Problems

1. `cwd` is simultaneously configuration, storage namespace, runtime cwd, and
   user-facing identity.
2. A dormant session cannot be opened without first creating or selecting a
   live instance.
3. `instanceId` is ephemeral but is currently the primary reconnect and
   navigation handle.
4. Manager-wide `switchSession` makes session navigation affect unrelated
   Connections attached to the same Manager.
5. At-most-one activation per session is implicit and can be violated by
   independent Manager creation paths.
6. A pending session opened for browsing can leave a runtime behind forever,
   while creating every opened session as a permanent runtime is wasteful.

This is primarily an ownership and protocol problem. The solution is not a
new persistent Project database. Projects are static daemon configuration;
sessions remain pi files; activations are internal runtime state.

## Domain model

```
Daemon
 ├── Project "foo"       static allowlisted configuration
 │    ├── Session S1      session file (or allocated, not-yet-flushed name)
 │    ├── Session S2
 │    └── Activation A1  internal runtime for S1 (never on the wire)
 │         ├── Connection C1
 │         └── Connection C2
 └── Project "bar"
      └── Activation A2
```

| Term | Definition | Identity | Lifetime |
|---|---|---|---|
| **Daemon** | Process that owns project configuration and live activations. | — | process |
| **Project** | One allowlisted cwd and its pi session namespace. | `projectId` | daemon configuration |
| **Session** | One pi session, addressed by a relative stem within the Project's session directory. An *active* session has a live runtime; an inactive one is only a file. | `sessionId` + `stem` | durable once flushed; tentative until then |
| **Activation** | Internal pi runtime and canonical Document for one active session. Never exposed to clients. | daemon-local | process, subject to GC |
| **Connection** | One client transport attached to at most one activation. | transport-local | socket |

"Active" is a property of a Session, not a separate domain object. The daemon
answers "which sessions are active" by projecting its internal activation
registry onto `SessionInfo`.

A Project is not an archival object. If a cwd is removed from `--allow`, its
sessions are simply not served by that daemon. There is no orphan-project UI,
project migration, or persisted project registry in v1.

### Cardinality

| Relation | Cardinality | Notes |
|---|---|---|
| daemon → project | 1 : N | Static configuration. |
| project → session | 1 : N | Determined by pi's session storage for the project cwd. |
| session → activation | ≤ 1 | Enforced by the daemon's activation map. |
| activation → session | 1 : 1 | An activation serves exactly one session for its lifetime. |
| activation → connection | 1 : N | Multiple viewers can share an activation. |
| connection → activation | ≤ 1 | Attachment is transport state. |

## Identity and storage

### Project identity

The daemon materializes each allow entry into a `ProjectConfig` before serving
connections:

```ts
interface ProjectConfig {
  id: string;
  cwd: string; // canonical absolute path
}
```

The CLI accepts these forms:

```text
--allow <path>             derive the project id from the path basename
--allow <id>=<path>        use an explicit project id
```

The explicit form splits at the first `=`; the remainder is the path, so a
path may itself contain `=`. An explicit id may not contain `=`.

Path canonicalization resolves an absolute path, removes redundant separators
and `.` components, and removes a trailing separator except for a filesystem
root. The daemon realpaths an existing cwd before deriving its storage
namespace. A missing or non-directory cwd is rejected during startup.

The default `projectId` is the lowercase basename of the canonical cwd. IDs
are validated, not silently slugified, against:

```text
^[a-z0-9]+(?:-[a-z0-9]+)*$
```

An explicit id is required when the basename is empty or does not satisfy that
rule. Duplicate ids are rejected at startup. Two Projects that resolve to the
same pi session storage namespace are also rejected, even if their ids differ.

Project IDs are stable across daemon restarts when the same configuration is
provided. They are not promised to survive arbitrary directory renames. A
future persisted project configuration can provide that guarantee if needed.

The daemon owns the mapping:

```text
projectId → canonical cwd
```

Clients never derive a cwd or a pi session directory from a project ID. The
public `cwd` field is display/configuration data only.

### Pi session storage

Pi's cwd-derived session directory remains the storage implementation. The
bridge may resolve it internally for direct stem lookup, but it is not part of
the Project domain object or public wire model. Use `sessionDir` or
`sessionStorage`, not "archive".

At startup, the daemon should reject two Projects that resolve to the same pi
session storage namespace. This is a storage collision check, not a project
archival feature. Without it, the same JSONL file could be addressed through
two project IDs and activation exclusivity would become ambiguous.

`sessionId` is globally unique by contract. Pi-generated session IDs are UUIDs;
custom or copied files that violate global uniqueness are outside the supported
session storage model. The stem and header id remain independent.

The daemon enforces this invariant at its boundaries rather than modeling
violations on the wire:

- at startup, a scan of all Project session namespaces detects a `sessionId`
  claimed by two distinct `(projectId, stem)` addresses and refuses to start;
- at `openSession`, the daemon compares the target header `sessionId` with the
  address already registered for that id. If a different address owns it, the
  open fails with a session-conflict error.

`listSessions` and `listActiveSessions` do not report conflicts. A duplicate
discovered after startup does not invalidate the already-registered address;
the server logs the conflict and the conflicting open fails. This treats
duplicate ids as unsupported input rather than a protocol state.

### Session address

A session is addressed by:

```ts
interface SessionAddress {
  projectId: string;
  stem: string;
}
```

`stem` is a relative session path, not an encoded session ID. Nested paths are
allowed. For example, `foo/bar` resolves to `<sessionDir>/foo/bar.jsonl`.
`sessionId` is read from the pi session header and remains the cache and
activation identity.

The canonical stem is a normalized relative path: forward slashes, no `.` or
`..` components, no leading or trailing slash, and no `.jsonl` extension. The
address is lexical; symlink resolution is a separate security step and does not
change the address string.

`stem` is known before the file exists. Pi allocates a session's filename
(`<fileTimestamp>_<sessionId>.jsonl`) when the session is created and only
writes the file once the session has an assistant message. The address
therefore covers both a durable session and one that has not been flushed yet.
Resolution checks live activations first, then disk:

```text
(projectId, stem)
  → live activation whose session file resolves to this stem, else
  → project session directory
  → candidate relative path + `.jsonl`
```

The server resolves a stem only within the selected Project's session storage.
The resolver must:

1. decode the URL path once;
2. reject NULs and absolute paths, including platform-specific drive or UNC
   paths;
3. resolve the candidate against the canonical Project session directory by
   filesystem resolution, not lexical normalization, so intermediate symlinks
   are covered;
4. verify that the canonical candidate remains contained by that directory;
   and
5. for an existing file, canonicalize the target and reject symlink targets
   outside the directory.

Containment and canonicalization are the security boundary. The bridge does
not require the stem suffix to match the header session ID. Pi's header is
authoritative for `sessionId`, and pi remains responsible for validating the
session file. A Project's session scanner uses the same containment rule and
only returns regular `.jsonl` files under the canonical session directory.

### Unflushed sessions

A session created by `newSession` has an allocated filename but no file until
pi flushes it (on the first assistant message). Until then it exists only
inside its activation. The address is unchanged: the client uses the allocated
stem from the start.

An unflushed session is resolvable only while its activation lives. If the
daemon restarts before a flush, the stem no longer resolves and the client
falls back to `/chat/<projectId>`. That is the same behavior as a session file
that has been deleted, so no separate route or metadata is needed.

Multiple unflushed sessions per Project are allowed. There is no single
"current" new session: each `newSession` call creates an independent session
with its own stem.

An unflushed session is still an active session and appears in active-session
queries and in Project browsing. It is a normal `SessionInfo`; only its backing
file does not exist yet.

## Activation lifecycle

Activations are internal and have no client-visible lifecycle. The daemon
creates one activation per active session and disposes it when it is idle.

### Idle collection

When the last Connection detaches from an activation, the daemon starts a
delayed GC timer. The timer is cancelled when the activation is reattached or
starts streaming.

GC is allowed only when all of the following hold:

```text
connectionCount == 0
isStreaming == false
isCompacting == false
```

and the session is durable (its file exists) or empty (no content beyond its
header).

`SessionManager` defers the write until an assistant message exists, so an
unflushed session can hold entries that are not yet on disk. As the one
exception, an entry-bearing unflushed activation is collected after a longer
single idle cap; collecting it drops those non-durable entries. This is a
deliberate tradeoff, recorded in Costs, not a tiered or configurable policy.

GC calls the normal Manager disposal path. It never deletes session files.

The eligibility check and the disposal must run under the same activation
reservation that `openSession` takes when it selects an activation. The timer
is asynchronous and `dispose()` awaits, so a check-then-dispose without the
reservation can dispose an activation that a concurrent `openSession` has just
reattached. `openSession` cancels the timer as part of reserving.

### Activation resolution

`openSession(projectId, stem)` resolves in this order:

1. If the stem resolves to a live activation, attach the Connection to that
   activation.
2. Otherwise, create a new activation for the session.

Activations are never rebound to a different session. This removes the
cross-session rebind race and the "unrelated attached Connections" hazard: a
Connection's activation always serves the session it attached to. There is no
cross-project reuse because the daemon never reuses a Manager across sessions
at all.

### Activation bookkeeping

The daemon keys every activation lookup on the session address:

```ts
addressKey(projectId, stem) = `${projectId}\0${stem}`

activations: Map<string, Manager>; // activationId → Manager
activationByAddress: Map<addressKey, activationId>;
pendingActivations: Map<addressKey, Promise<Manager>>; // in-flight create
gcTimers: Map<addressKey, ReturnType<typeof setTimeout>>; // pending disposal
sessionOwnerById: Map<sessionId, SessionAddress>; // duplicate-id check
```

`activationByAddress`, `pendingActivations`, and `gcTimers` share the address
key, so resolution, locking, and collection cannot disagree about which session
an activation serves. `sessionId` is not a lock key: for a durable stem it is
only known after a header read, and that read must not happen before the
reservation is taken.

`pendingActivations` serializes concurrent opens for the same address.
`gcTimers` holds delayed disposal; reserving an activation cancels its timer.
Because Manager creation is asynchronous, check-then-create without the lock
can create duplicate activations for one session.

`sessionOwnerById` is a single-owner index used only by the startup and
`openSession` duplicate checks. It is not part of the wire protocol.

## Protocol v2

The protocol is upgraded to model Projects and Sessions explicitly. Activations
remain daemon-internal implementation state. This is a typed domain
protocol, not the generic object-kernel protocol proposed by ADR 08. The
existing WebSocket transport, Document patches, lazy pulls, and cursor
semantics remain.

The v2 protocol is a coordinated bridge/client change. It does not preserve
path-based session navigation as a second protocol.

### Daemon and navigation operations

```ts
getDaemonInfo()
  → { projects: ProjectInfo[], models, thinkingLevels, devMode }

interface ProjectInfo {
  id: string;
  cwd: string;
}

listSessions({ projectId, max?, cursor? })
  → { sessions, hasMore, nextCursor? }

listActiveSessions()
  → { sessions: SessionInfo[] }

openSession({ projectId, stem, cursor? })
  → { ok, session: SessionInfo }

newSession({ projectId })
  → { ok, session: SessionInfo }

detach()
  → { ok }
```

`listSessions` is the paginated history query. It retains the existing
incremental loading behavior while replacing the timestamp-only boundary with
a total-order cursor:

```ts
interface SessionListCursor {
  sortTimeMs: number;
  stem: string;
}
```

Durable files are ordered by filesystem `mtimeMs` descending, then canonical
stem descending. An unflushed active session has no file mtime, so its
`sortTimeMs` is the millisecond value of its in-memory pi session-header
creation timestamp. `SessionInfo.timestamp` is the ISO representation of the
same ordering value: file mtime for a durable file, header creation time for
an unflushed session. `cursor` is exclusive and `nextCursor` identifies the
last returned position.

The scan is recursive under the Project's canonical session directory, and the
daemon mtime cache remains keyed by canonical file path. Active sessions are
included rather than filtered after pagination; each result carries `active`
and `isStreaming` state, and an active session that has not flushed yet is
included from the activation index.

mtime is a deliberate approximation: it lets pagination run from `stat`
without reading file contents. It is not immutable — appending to a session,
or reopening a file that pi migrates, changes it. Paging is therefore
best-effort for the actively-written session. When an unflushed session first
flushes, its ordering value changes from the header timestamp to filesystem
mtime and the daemon publishes a session-list refresh. That refresh invalidates
the client's current pagination cursor; the client restarts from the first
page. Client de-duplication by `sessionId` prevents duplicate rows while the
new snapshot replaces the old one, but cannot recover a session that moved
from a later page above an already-consumed cursor. The untouched tail, whose
mtime does not change, pages stably.

`listActiveSessions` is a view over the same model: sessions with the same
`SessionInfo` shape, sourced from the daemon's activation index rather than a
directory scan. It is global (not project-scoped) so the launcher can show
work across Projects, and it includes active sessions that have not flushed.
It is not paginated.

`openSession` resolves a relative stem within the selected Project only, and
never accepts an arbitrary filesystem path. It attaches to a live activation
whose session resolves to that stem, otherwise creates one from the file.

`newSession` creates a new unflushed session and returns its metadata. The
client addresses it by the returned stem. There is no single "current" new
session per Project.

`detach` removes the Connection's attachment but leaves the activation alive
for later reattachment or internal GC. Activation termination is not a
client-facing operation.

The following old operations and pushes are removed from the v2 client surface:

```text
switchSession(sessionPath)
switchInstance(instanceId)
newInstance(cwd)
listInstances()
killInstance(instanceId)
detachInstance()             (replaced by detach())
getDaemonInfo.cwdAllowlist   (replaced by projects)
instance_exit push
```

`Manager.switchSession(path)` is not called by the v2 daemon: activations are
never rebound to a different session. The rebind plumbing is retained only
because pi's runtime exposes it and is expected to be removed once it is
demonstrably unused.

### Attached session operations

These operations target the session attached to the requesting Connection:

```text
prompt
executeBash
abort
discardSteer
setModel
setThinkingLevel
renameSession
navigate
listFiles
readFile
gitShow
pull
```

`listFiles`, `readFile`, and `gitShow` resolve relative paths against the
attached session's Project cwd and require an attachment. Replies remain
acknowledgements/failure channels. Document state continues to arrive through
push messages.

### Initial sync metadata

Initial synchronization uses a small session reference rather than the full
launcher/list item:

```ts
interface SessionRef {
  projectId: string;
  sessionId: string;
  stem: string;
}
```

The wire shapes are:

```ts
interface ReplacePush {
  kind: "replace";
  session: SessionRef;
  document: Document;
}

interface PatchPush {
  kind: "patch";
  /** Present only for a cursor-aware initial-sync patch. */
  session?: SessionRef;
  ops: PatchOp[];
}

type ServerPushMessage =
  | ReplacePush
  | PatchPush
  | SessionsChangedMessage
  | ActiveSessionsChangedMessage;
```

A `replace` push always carries `session`. A `patch` push carrying `session` is
the cursor-aware initial-sync patch; a patch without it is a live Document
patch. The `sessionId` in `SessionRef` is the cache/candidate-mirror identity,
while `projectId` and `stem` are the client address.

For `openSession` and `newSession`, the daemon commits the Connection
attachment, clears its lazy subscriptions, and sends the initial-sync push
before sending the successful RPC reply. The reply means that the attachment
and initial mirror state are committed. A failed operation sends no success
reply and no initial-sync push. This ordering also applies when a candidate
mirror is promoted from a cursor-aware initial patch. A successful open
first detaches the Connection from any previous activation; a failed open
leaves the previous attachment and mirror untouched.

Initial-sync frames bypass wire compaction. `CompactCodec` encodes a single-op
`append` patch as a bare string keyed by a remembered path; a cursor-aware
initial patch carries `session`, so compacting it would drop the address, and
a stale remembered path must not survive an attach. Frames carrying `session`
are always emitted in full, and `Connection.attach` resets the codec.

No activation identity, lifecycle, or connection count crosses the wire.

A reconnect is resolved by `openSession(projectId, stem, cursor?)`, not by
reviving an activation id. If a live activation for the session still exists,
the daemon reattaches to it; otherwise it creates one from the file. An
unflushed session resolves only while its activation lives; after a daemon
restart the client falls back to `/chat/<projectId>`.

### Registry and session updates

Activation creation, collection, reattachment, and settlement are internal
daemon events. They are not exposed as messages. The daemon uses them to
maintain `listActiveSessions` and to publish session-oriented updates.

`SessionsChangedMessage` is project-scoped and carries the first paginated
page used to refresh that Project's session list. The daemon broadcasts it to
all live Connections, including unattached Connections currently showing a
launcher:

```ts
interface SessionsChangedMessage {
  kind: "sessions_changed";
  projectId: string;
  sessions: SessionInfo[];
  hasMore: boolean;
  nextCursor?: SessionListCursor;
}
```

Active and streaming state changes are reported through a global snapshot. The
daemon broadcasts it to all live Connections; `SessionInfo.projectId` carries
the Project identity, so no top-level Project field is needed:

```ts
interface ActiveSessionsChangedMessage {
  kind: "active_sessions_changed";
  sessions: SessionInfo[];
}
```

Both snapshots are session data only; neither carries an activation id, and
active sessions that have not flushed are included. A later subscription
optimization may reduce broadcast traffic without changing these payloads.

### Session metadata

```ts
interface SessionInfo {
  projectId: string;
  sessionId: string;
  stem: string;
  active: boolean;
  isStreaming: boolean;
  name?: string;
  timestamp: string;
  firstMessageText?: string;
  messageCount?: number;
}
```

`stem` is always present, including for an unflushed session. It omits the
`.jsonl` extension; for a legacy or renamed file it is the relative path minus
that extension, independent of pi's `<timestamp>_<sessionId>` naming. The
header id remains authoritative for `sessionId`. `timestamp` is an ISO
rendering of the ordering value described above: filesystem mtime for durable
sessions and the in-memory header creation time before flush. `sessionPath` is
not public wire data.

## Client state and URLs

The client store keeps:

- the current Document;
- the current session address `(projectId, stem)` and its `sessionId`;
- Projects and project-scoped session lists;
- active/streaming session state from the session-oriented query and pushes.

The URL is a projection of the current session address. The session path is
the remainder of the URL after the Project segment, so nested stems are
supported. The client percent-encodes each stem segment and the server decodes
the path once; a stem containing a literal `%2F` round-trips as `%252F`:

```text
/launcher                           project picker + active sessions across Projects
/chat/<projectId>                   the Project's launcher: session browser + New
/chat/<projectId>/<relative-stem>   one session
```

`/chat/<projectId>` is the Project's home, the same launcher surface as
`/launcher` scoped to one Project: it lists the Project's sessions, shows
active/streaming state, and hosts the New-session action. There is no separate
empty-session route. A new session is just a session with an unflushed stem,
and the client navigates to `/chat/<projectId>/<stem>` as soon as `newSession`
returns.

The URL is read at boot to select an initial session and is written with
`replaceState`. It is not consulted as a second live navigation state machine.

A session URL survives daemon restart while the file and Project configuration
still exist. An unflushed session's URL survives only while its activation
remains live in the same daemon; otherwise the client falls back to
`/chat/<projectId>`.

The HTTP server serves `index.html` for the known application routes. Static
assets are served by exact path; unknown assets remain 404. Route segments are
decoded and validated before use.

## Exclusivity and races

The daemon enforces:

```text
at most one live activation for sessionId
```

Two concurrent `openSession` calls for the same session share one
`pendingActivations` promise and attach to the resulting activation. A second
open of an already-live session attaches to the existing activation rather
than creating another Manager. Because activations are never reused across
sessions, there is no cross-session rebind to serialize.

The daemon does not use filename suffixes, client-provided activation ids, or
list filtering as the exclusivity mechanism.

## Testing plan

### Project and storage

- derive and validate default project IDs;
- parse `--allow <path>` and first-`=` explicit id/path entries;
- canonicalize existing cwd paths and reject missing/non-directory paths;
- reject invalid explicit IDs and default basenames that require an explicit id;
- reject duplicate project IDs;
- detect session-storage collisions;
- recursively discover regular session files under the canonical session
  directory;
- resolve nested stems only inside the selected session directory;
- reject absolute paths, NUL, and escaping symlinks;
- open legacy or renamed files using the header session ID without deriving it
  from the stem;

### Session resolution

- open a session `(projectId, stem)`, including a nested stem;
- reject an unknown stem;
- reject a stem from another Project;
- resolve an unflushed session by its allocated stem while its activation
  lives;
- reject an unflushed session's stem after daemon restart;
- keep `sessionId` and stem independent in metadata and cache keys;
- list an unflushed active session as a normal `SessionInfo`, using its header
  creation timestamp for ordering and `timestamp`;
- move an unflushed session to filesystem mtime ordering after its first flush;
- reject the same `sessionId` appearing in two Projects at startup;
- fail `openSession` when the target header id is already owned by a different
  address;
- keep an already-running session usable when a conflicting copy appears;
- paginate files with equal mtimes without skipping or repeating a stem;
- de-duplicate a page by `sessionId` when an active session's ordering time
  changed between pages;
- restart pagination from the first page after a `sessions_changed` refresh.

### Activation lifecycle

- two concurrent opens of the same session produce one activation;
- opening a live session reattaches rather than duplicates;
- detached idle activations are GC'd after the delay;
- attached activations are not GC'd;
- streaming or compacting activations are not GC'd;
- a GC timer racing `openSession` does not dispose a reattached activation;
- an entry-bearing unflushed activation is collected only after the longer idle
  cap;
- GC never deletes a session file.

### Protocol and client

- initial `replace` syncs carry the exact `SessionRef` shape and Document;
- cursor-aware initial `patch` syncs carry `SessionRef`, live patches do not;
- initial sync is delivered before the successful navigation RPC reply;
- `openSession` uses the cursor and initial-sync ordering rules from ADR 09;
- reconnect resolves by project/stem rather than an activation id;
- `listSessions` preserves incremental page loading with the compound cursor,
  including equal-mtime files;
- `listActiveSessions` returns active sessions, including unflushed ones,
  without a filesystem scan;
- the global `active_sessions_changed` snapshot reaches unattached launcher
  connections;
- `sessions_changed` is broadcast by the daemon and carries the Project's first
  page;
- a session-list refresh invalidates the current pagination cursor and causes
  the client to restart from the first page;
- a cursor-aware initial `patch` is never compacted to a bare append string;
- a failed open leaves the previous attachment and mirror intact;
- no public RPC accepts a session filesystem path or an activation id;
- `newSession` twice for one Project yields two independent unflushed sessions.

## Consequences

### Positive

- Session navigation names the object the user means: a Project and a Session.
- Activation ids are never links or reconnect identities.
- Opening and browsing many sessions does not permanently create runtimes:
  idle activations are collected.
- Exclusivity is explicit and race-safe.
- GC is a runtime policy, not a second session model.
- Active is session metadata, not a separate domain object; the client queries
  active sessions without knowing how they are activated.
- Existing Document synchronization and ADR 09 cache semantics remain useful.

### Costs

- The web and server must move together to protocol v2.
- The daemon gains activation indexing, delayed GC, and session-oriented
  active-state reporting.
- Initial-sync frames carry Project/Session metadata.
- Projects with the same pi storage namespace must be rejected or treated as
  aliases; v1 chooses rejection.
- An unflushed session cannot be reopened after daemon restart; the client
  falls back to the Project page.
- Pagination keyed on mtime is approximate for actively-written sessions; the
  client de-duplicates by `sessionId` and the daemon pushes refreshes.
- An entry-bearing unflushed session that never flushes (for example,
  prompt-then-abort) is collected after a long idle cap and its entries are
  lost; they were never durable.
- Duplicate `sessionId` files created after startup are unsupported: the
  first-registered address keeps working and a conflicting open fails.
- The daemon creates one Manager per active session instead of reusing one
  across sessions, so Manager creation cost is paid on each open.

## Open questions deferred from v1

- The exact GC delay and the longer cap for entry-bearing unflushed
  activations, and whether either becomes configurable.
- Whether the launcher auto-opens the most recent session or requires an
  explicit choice; v1 shows the Project home.
- Whether browser Back/Forward should drive session navigation; v1 uses
  `replaceState` only.
- Whether a later subscription protocol should reduce the v1 daemon-level
  broadcast traffic; the v1 payloads and recipient semantics are defined
  above.
- Cross-process daemons serving the same pi session directory. The in-process
  activation map does not provide cross-process locking.

## Relationship to other ADRs

- **ADR 02:** unchanged Document and entry model. Session ownership changes
  only at the host/routing layer.
- **ADR 06 / architecture.md:** superseded where they define instance-centric
  routing verbs, the instance push table, and the `instance_exit`
  kill-discovery addendum. The Manager and Connection implementation seams
  remain useful, but public navigation becomes Project/Session based,
  activations stay internal, and daemon shutdown closes the socket.
- **ADR 07:** the client store tracks the current session address; the sidebar
  becomes a Project/Session browser with active/streaming state.
- **ADR 08:** not adopted by this ADR. A future object-kernel implementation
  can host the same Project and Session objects.
- **ADR 09:** cache identity and prefix cursor rules are unchanged, but the
  frame shapes are not: `ReplaceMessage`/`PatchMessage` carry `SessionRef`
  instead of a bare `sessionId`, and the `switchInstance`/`switchSession`
  cursor carriers are gone. Cursors remain keyed by globally unique
  `sessionId`; the Project/stem address only resolves the session.
- **ADR 10:** unchanged. Git stamps remain entries in the active session.
- **PRD 04:** its instance/session sidebar is replaced by a project launcher:
  a Project/Session browser with active/streaming session indicators.
