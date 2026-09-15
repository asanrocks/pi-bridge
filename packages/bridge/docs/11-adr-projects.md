# ADR 11: Projects, Sessions, and Activations

**Status:** Proposed. Reworks the daemon's session domain model and the client
protocol around three distinct concepts: a static `Project` configuration, a
durable `Session` file, and an ephemeral `Instance` activation. The protocol
uses session addresses for navigation. Instance activations and their
identifiers remain daemon-internal.

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
- `listSessions` scans pi's cwd-derived session directory and returns file
  paths.
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
sessions remain pi files; instances are runtime activations.

## Domain model

```
Daemon
 ├── Project "foo"       static allowlisted configuration
 │    ├── Session S1      durable pi JSONL file
 │    ├── Session S2
 │    └── Instance I1     ephemeral activation of one session
 │         ├── Connection C1
 │         └── Connection C2
 └── Project "bar"
      └── Instance I2
```

| Term | Definition | Identity | Lifetime |
|---|---|---|---|
| **Daemon** | Process that owns project configuration and live activations. | — | process |
| **Project** | One allowlisted cwd and its pi session namespace. | `projectId` | daemon configuration |
| **Session** | One pi session file, addressed by a relative stem within the Project's session directory. | `sessionId` + `stem` | while file exists |
| **Instance** | Internal pi runtime and canonical Document activation for one session. | daemon-local | process, subject to GC |
| **Connection** | One client transport attached to at most one internal activation. | transport-local | socket |

A Project is not an archival object. If a cwd is removed from `--allow`, its
sessions are simply not served by that daemon. There is no orphan-project UI,
project migration, or persisted project registry in v1.

### Cardinality

| Relation | Cardinality | Notes |
|---|---|---|
| daemon → project | 1 : N | Static configuration. |
| project → session | 1 : N | Determined by pi's session storage for the project cwd. |
| session → live instance | ≤ 1 | Enforced by the daemon's activation map. |
| instance → session | 1 : 1 at a time | A pending instance may be reused for another session. |
| instance → connection | 1 : N | Multiple viewers can share an activation. |
| connection → instance | ≤ 1 | Attachment is transport state. |

## Identity and storage

### Project identity

The default `projectId` is the last segment of the normalized allowlisted cwd.
An explicit `id=path` allow entry is available when a deliberate alias is
needed. IDs are lowercase URL-safe slugs. Duplicate IDs are rejected at
startup.

Project IDs are stable across daemon restarts when the same configuration is
provided. They are not promised to survive arbitrary directory renames. A
future persisted project configuration can provide that guarantee if needed.

The daemon owns the mapping:

```text
projectId → normalized cwd
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

### Session address

A durable session is addressed by:

```ts
interface SessionAddress {
  projectId: string;
  stem: string;
}

const TEMPORAL_SESSION_STEM = "__temporal__";
```

`SessionAddress` represents a durable session. `TEMPORAL_SESSION_STEM` is a
reserved protocol sentinel, not a filesystem stem or a `SessionAddress`.

`stem` is a relative session path, not an encoded session ID. Nested paths are
allowed. For example, `foo/bar` resolves to
`<sessionDir>/foo/bar.jsonl`. `sessionId` is read from the pi session header
and remains the cache and activation identity.

The server resolves a stem only within the selected Project's session storage:

```text
(projectId, stem)
  → project session directory
  → candidate relative path + `.jsonl`
```

The resolver must:

1. decode the URL path once;
2. reject NULs and absolute paths, including platform-specific drive or UNC
   paths;
3. resolve the candidate against the canonical Project session directory;
4. verify that the canonical candidate remains contained by that directory;
   and
5. for an existing file, canonicalize the target and reject symlink targets
   outside the directory.

The exact root-level stem `TEMPORAL_SESSION_STEM` is reserved and is handled
as a temporal-session lookup before filesystem resolution. It is never joined
to the session directory.

Containment and canonicalization are the security boundary. The bridge does
not require the stem suffix to match the header session ID. Pi's header is
authoritative for `sessionId`, and pi remains responsible for validating the
session file. A Project's session scanner uses the same containment rule and
only returns regular `.jsonl` files under the canonical session directory.

### Temporal sessions

`SessionManager` allocates the intended filename before the first durable
flush. Each Project may have at most one temporal, non-durable session. An
attached Connection receives:

```ts
interface AttachedSession {
  projectId: string;
  sessionId: string;
  /** null until the session file is durable. */
  stem: string | null;
  durable: boolean;
}
```

The temporal session is not included in Project session browsing or active
session queries. It is addressed through the reserved route marker:

```text
/chat/<projectId>/__temporal__
```

The marker is not a durable permalink. It resolves only while the Project's
sole temporal session exists in the same daemon. If it no longer exists, the
client replaces the URL with `/chat/<projectId>`.

After the first flush, the daemon updates the attached-session metadata with
the durable stem and the client replaces the marker URL with
`/chat/<projectId>/<stem>`. The client still knows only the Project and
Session; the activation that serves them remains internal.

## Activation lifecycle

Instances have an internal lifecycle:

```ts
type InstanceLifecycle = "pending" | "permanent";
```

### Pending instances

A pending instance is a runtime opened for browsing or a new session that has
not started an agent turn in this activation. It may have attached idle
Connections. It is GC-eligible only after all Connections detach.

A pending instance is promoted when the Manager first transitions into active
streaming (`/status/isStreaming: false → true`). Promotion is permanent for
the activation lifetime. Activation termination remains an internal daemon
operation.

### Garbage collection

When the last Connection detaches from a pending instance, the daemon starts a
delayed GC timer. The timer is cancelled when the instance is reattached or
starts streaming.

GC is allowed only when:

```text
lifecycle == "pending"
connectionCount == 0
isStreaming == false
```

GC calls the normal Manager disposal path. It never deletes session files. A
new unflushed session may lose its empty in-memory activation, but no durable
session data is removed.

Permanent instances are not automatically collected. This avoids killing
background work merely because the UI temporarily disconnected. Activation
termination is an internal daemon/shutdown operation, not a client-facing
instance-management operation.

### Reuse

`openSession(projectId, stem)` resolves activations in this order:

1. If `stem` is `TEMPORAL_SESSION_STEM`, attach to the Project's sole temporal
   session, returning not-found if none exists.
2. If the durable target session already has a live activation, attach the
   Connection to that activation.
3. Otherwise, if the requesting Connection is the only Connection on a
   pending same-project instance, detach it and reuse that instance.
4. Otherwise, reuse an unattached pending same-project instance.
5. Otherwise, create a new Manager for the durable target session.

The daemon must not rebind an instance with unrelated attached Connections.
Those Connections must continue observing their current session.

Cross-project pending-instance reuse is deferred. A Manager captures
project-local settings and extension state; reusing it across Projects requires
explicit cwd, trust, settings, and extension rebinding.

### Activation bookkeeping

The daemon maintains both the instance registry and a reverse session index:

```ts
instances: Map<string, Manager>;
activationBySession: Map<string, string>; // sessionId → instance
temporalActivationByProject: Map<string, string>; // projectId → instance
pendingActivations: Map<string, Promise<Activation>>;
activationReservations: Map<string, Promise<void>>;
```

`pendingActivations` serializes concurrent opens for the same session.
`temporalActivationByProject` enforces the one-temporal-session-per-Project
rule. `activationReservations` serializes selection and rebinding of a pending
instance, including opens for different sessions. Manager creation and
rebinding are asynchronous, so check-then-create or check-then-rebind without
these locks can create duplicate activations or race one Manager onto two
sessions.

The reverse indexes are updated atomically when an activation is created,
reused, rebound, or disposed. Creating a second temporal session for one
Project reuses the existing temporal activation rather than creating another
one.

## Protocol v2

The protocol is upgraded to model Projects and Sessions explicitly. Instance
activations remain daemon-internal implementation state. This is a typed domain
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

listActiveSessions({ projectId? })
  → { sessions }

openSession({ projectId, stem, cursor? })
  → { ok, session: AttachedSession }

newSession({ projectId })
  → { ok, session: AttachedSession }

detach()
  → { ok }
```

`listSessions` is the paginated durable-history query. It retains the existing
incremental loading behavior while replacing the timestamp-only boundary with
a total-order cursor:

```ts
interface SessionListCursor {
  mtimeMs: number;
  stem: string;
}
```

Sessions are ordered by file mtime descending, then canonical stem descending.
`cursor` is exclusive and `nextCursor` identifies the last returned position.
The scan is recursive under the Project's canonical session directory, and the
daemon mtime cache remains keyed by canonical file path. `SessionInfo.timestamp`
is the file mtime as an ISO string. Active durable sessions are included rather
than filtered after pagination; each result carries `active` and `isStreaming`
state.

`listActiveSessions` is backed by the daemon's internal activation index rather
than a session-directory scan. It returns active durable sessions and their
streaming state. Non-durable sessions are omitted from both browsing queries.

`openSession` accepts either a durable relative stem or the reserved
`TEMPORAL_SESSION_STEM`. The sentinel resolves the Project's sole temporal
session; it is never treated as a filesystem path. Durable stems are resolved
only within the selected Project and the operation never accepts an arbitrary
filesystem path.

`newSession` creates or reuses the Project's sole temporal session and returns
attached session metadata. The client writes the temporal route marker rather
than a provisional filesystem stem. The session's real stem becomes a durable
address only after pi flushes the file.

`detach` removes the Connection's attachment but leaves the activation alive
for reuse or internal GC. Activation termination is not a client-facing
operation.

The following old operations are removed from the v2 client surface:

```text
switchSession(sessionPath)
switchInstance(instanceId)
newInstance(cwd)
listInstances()
killInstance(instanceId)
```

Manager-level `switchSession(path)` and `newSession()` may remain as internal
runtime operations. They are not the domain navigation protocol.

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
pull
```

Replies remain acknowledgements/failure channels. Document state continues to
arrive through push messages.

### Initial sync metadata

The existing `replace` and cursor-aware initial-sync patch carry the attached
session metadata in addition to the Document:

```ts
interface AttachedSession {
  projectId: string;
  sessionId: string;
  stem: string | null;
  durable: boolean;
}
```

The initial-sync frame includes the relevant `AttachedSession` and the
Document. No instance identity, lifecycle, or connection count crosses the
wire. After the first flush, the daemon sends an `attached_session_changed`
push so the client can write the durable URL.

A reconnect is resolved by `openSession(projectId, stem, cursor?)`, not by
reviving an instance id. A durable URL supplies its durable stem. The temporal
route supplies `TEMPORAL_SESSION_STEM` and reattaches only if the Project's
sole temporal session still exists; otherwise the client falls back to the
Project route. If a live activation for a durable session still exists, the
daemon reattaches to it. If not, it reactivates the durable session.

### Registry and session updates

Activation creation, reuse, promotion, rebinding, detachment, GC, and
termination are internal daemon events. They are not exposed as instance
messages. The daemon may use them to maintain `listActiveSessions` and to
publish session-oriented updates.

`SessionsChangedMessage` is project-scoped and carries the first paginated
page used to refresh the durable session list:

```ts
{
  kind: "sessions_changed";
  projectId: string;
  sessions: SessionInfo[];
  hasMore: boolean;
  nextCursor?: SessionListCursor;
}
```

An attachment becoming durable is reported after the normal durable Document
patches, so the file exists before the client writes its address:

```ts
{
  kind: "attached_session_changed";
  session: AttachedSession;
}
```

Active and streaming state changes are reported through a session-oriented
active-session update:

```ts
{
  kind: "active_sessions_changed";
  projectId: string;
  sessions: SessionInfo[];
}
```

The snapshot contains active durable sessions for that Project and never
contains instance ids. Non-durable sessions are not included in either
browser-facing list.

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

`sessionPath` is not public wire data. The client never parses or sends
filesystem paths.

## Client state and URLs

The client store keeps:

- the attached Document;
- the current `AttachedSession`, without instance identity;
- the durable `SessionAddress` or temporal route when available;
- Projects and project-scoped session lists;
- active/streaming session state from the session-oriented query and pushes.

The URL is a projection of the current session address. The session path is
the remainder of the URL after the Project segment, so nested stems are
supported. The reserved temporal marker is a separate route target:

```text
/launcher
/chat/<projectId>
/chat/<projectId>/<relative-stem>
/chat/<projectId>/__temporal__
```

The URL is read at boot to select an initial session and is written with
`replaceState`. It is not consulted as a second live navigation state machine.

A durable session URL survives daemon restart while the file and Project
configuration still exist. The temporal route survives only while the sole
temporal session remains live in the same daemon; after its first flush, the
client replaces it with the durable URL.

The HTTP server serves `index.html` for the known application routes. Static
assets are served by exact path; unknown assets remain 404. Route segments are
decoded and validated before use.

## Exclusivity and races

The daemon enforces:

```text
at most one live activation for sessionId
```

Two concurrent `openSession` calls for a dormant session share one
`pendingActivations` promise and attach to the resulting activation. Pending
activation reuse is also serialized per activation: a pending instance is
reserved before an asynchronous rebind, so concurrent opens for different
sessions cannot race to reuse the same Manager. A second open of an
already-live session attaches to the existing activation rather than creating
another Manager.

The daemon does not use filename suffixes, client-provided instance IDs, or
list filtering as the exclusivity mechanism.

## Testing plan

### Project and storage

- derive and validate default project IDs;
- parse explicit `id=path` entries;
- reject duplicate project IDs;
- detect session-storage collisions;
- recursively discover regular session files under the canonical session
  directory;
- resolve nested stems only inside the selected session directory;
- reject absolute paths, NUL, and escaping symlinks;
- open legacy or renamed files using the header session ID without deriving it
  from the stem;

### Session resolution

- open a durable `(projectId, stem)` session, including a nested stem;
- reject an unknown stem;
- reject a stem from another Project;
- resolve `TEMPORAL_SESSION_STEM` to the Project's sole live temporal session;
- reject the temporal marker after daemon restart when no temporal activation
  exists;
- reject a real filesystem stem equal to the reserved temporal marker;
- keep `sessionId` and stem independent in metadata and cache keys;
- update attached-session metadata when the first flush makes the stem durable;
- replace the temporal URL with the durable stem after the first flush;
- paginate files with equal mtimes without skipping or repeating a stem.

### Activation lifecycle

- two concurrent opens of the same session produce one activation;
- concurrent opens of different sessions cannot reuse one pending instance at
  the same time;
- opening a live session reattaches rather than duplicates;
- a pending instance with no Connections is reused;
- a pending instance with another attached Connection is not rebound;
- first streaming transition promotes an instance permanently;
- detached pending instances are GC'd after the delay;
- attached pending instances are not GC'd;
- permanent detached instances are not automatically GC'd;
- GC never deletes a session file.

### Protocol and client

- initial sync includes attached Project/Session metadata, never activation
  metadata;
- `openSession` uses the cursor and initial-sync ordering rules from ADR 09;
- reconnect resolves by project/stem rather than instance ID;
- `listSessions` preserves incremental page loading with the compound cursor,
  including equal-mtime files;
- `listActiveSessions` returns active durable sessions without a filesystem
  scan;
- temporal sessions do not appear in either browser-facing session query;
- `attached_session_changed` follows the first durable Document patch and
  carries no instance metadata;
- `active_sessions_changed` contains Project/Session data only;
- `sessions_changed` includes its project ID;
- no public RPC accepts a session filesystem path or instance ID;
- switching from one session to another does not rebind a Manager with unrelated
  attached Connections;
- temporal attached-session metadata becomes durable after first flush.

## Consequences

### Positive

- Session navigation names the durable object the user means.
- Instance IDs are no longer used as links or reconnect identities.
- Opening and browsing many sessions does not permanently create runtimes.
- Exclusivity is explicit and race-safe.
- GC is a runtime policy, not a second session model.
- The client can query active and streaming sessions without knowing how they
  are activated.
- Existing Document synchronization and ADR 09 cache semantics remain useful.

### Costs

- The web and server must move together to protocol v2.
- The daemon gains activation indexing, lifecycle transitions, delayed GC, and
  session-oriented active-state reporting.
- Initial-sync frames carry attached Project/Session metadata.
- Projects with the same pi storage namespace must be rejected or treated as
  aliases; v1 chooses rejection.
- A temporal session cannot be reopened after daemon restart until it has
  flushed a file; the temporal route falls back to the Project page.

## Open questions deferred from v1

- The exact GC delay and whether it becomes configurable.
- Whether the temporal route should be shown as a distinct Project-page state
  when no durable sessions exist.
- Whether browser Back/Forward should drive session navigation; v1 uses
  `replaceState` only.
- Whether project-scoped session pushes broadcast to all Connections or are
  queried on demand; either way, the payload remains Project/Session scoped.
- Cross-process daemons serving the same pi session directory. The in-process
  activation map does not provide cross-process locking.

## Relationship to other ADRs

- **ADR 02:** unchanged Document and entry model. Session ownership changes
  only at the host/routing layer.
- **ADR 06:** superseded where it defines instance-centric routing verbs. The
  Manager and Connection implementation seams remain useful, but public
  navigation becomes Project/Session based.
- **ADR 07:** the client store tracks the attached session address; the sidebar
  becomes a Project/Session browser with active/streaming state.
- **ADR 08:** not adopted by this ADR. A future object-kernel implementation
  can host the same Project, Session, and Instance objects.
- **ADR 09:** unchanged cache identity and prefix cursor rules. Cursors remain
  keyed by globally unique `sessionId`; the Project/stem address only resolves
  the session.
- **ADR 10:** unchanged. Git stamps remain entries in the active session.
- **PRD 04:** its instance/session sidebar is replaced by a Project/Session
  browser with active/streaming session indicators.
