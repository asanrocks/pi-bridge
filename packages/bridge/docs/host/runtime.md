# Host Runtime

The host is the Node-side owner of live Sessions and the WebSocket protocol. A
Daemon owns the Connections, the browser attachment stream, and delivery. A
Worker owns the Projects, Session storage, Activations, pi runtimes, and
repository reads; the two halves run in one process today. An Activation
contains one Manager and serves exactly one Session for its entire lifetime.
Activations are worker-internal; the wire carries Session addresses and
references, never an Activation.

## Worker service boundary

`src/host/worker-contract.ts` is the Daemon → Worker contract. It carries
values and opaque ids only: no `Connection`, `Manager`, `ActivationRecord`,
filesystem handle, or registry object crosses it, so a Worker could move
behind a socket without the Daemon branching on locality.

Three identities are distinct, and the distinction is what makes stale work
recognizable without consulting a runtime:

- `WorkerRegistration` names one Daemon↔Worker link: an `id`, the serving
  run's `incarnation`, and the registration's `generation` within it.
- `SessionTarget` names one Activation for work: `(projectId, stem)`, the
  durable `sessionId`, the `SessionRef`'s reported `cwd` for attachment-bound
  repository reads, the `worker` registration that resolved it, and that
  registration's activation generation. A command runs against the target it
  names; a target whose Activation ended is refused, never retargeted.
- An **observation** names one Document sync of one target, with its own lazy
demand and its own release. Two Connections observing the same Session hold
two observations; releasing one leaves the other delivering.

The Worker's frame stream is attachment-generation-free (`replace`, `patch`,
`closed`), because a Worker serves many attachments and never encodes a
client's identity. The Daemon mints one attachment generation per browser
attach and stamps the frames it forwards, which is the rule in
[core protocol](../core/protocol.md).

`src/host/worker-local.ts` is that contract's in-process implementation. It
owns the Activation registry, the per-session choreography (Manager creation,
registration, the pre-attach model/thinking choices, first-prompt admission),
the Session catalog (`src/host/session-catalog.ts`: directory scan, durable
metadata parse, live overlay), and the observation table. The Daemon holds no
Activation state and never sees a Manager: it resolves a Project, asks the
Worker for an observation, and stamps the frames the observation delivers.
The repository read surface (`src/host/repository.ts`: snapshot reads,
directory listings, the review diff directive, `git show`, path completion of
the Project home) is its own module, shared by whichever side serves the
request.

An observation is installed as one unit: one actor capability (the counted
liveness signal that keeps the Activation alive) plus one observer handle over
the Manager's patch stream. The initial sync is emitted synchronously during
acquisition, so a caller never receives an observation without its baseline.
Releasing it removes that handle and that capability — sibling observations
and the Session's command admission are untouched. When a registration is
collected, the Worker ends its observations after the actor's close flushed
the final patches: the `closed` frame is delivered before `collect` resolves,
so `session_closed` precedes the close reply on the wire.

The canonical Session content is a `Document` owned by its Manager. The
Document and its patch protocol are defined in [the core data model](../core/data-model.md).
The host's initial-sync and lazy-field behavior uses the wire contract in
[core protocol](../core/protocol.md); this document covers the host ownership
and routing around that contract.

## Offline Mode

The daemon always starts pi-core in offline mode. `Daemon.start` writes
`PI_OFFLINE=1` and `PI_SKIP_VERSION_CHECK=1` into `process.env` before it
creates the ModelRuntime or loads extensions, overwriting any inherited value.
pi reads those variables at call time — tool binary downloads, catalog and
package refreshes, and other automatic startup paths — so the embedded runtime
observes one mode and bridge needs no second switch. There is deliberately no
online flag: a caller that needs pi-core's automatic network work runs pi
itself.

Offline mode covers automatic network activity, not network access in general.
The bridge performs no network I/O of its own: it restores model catalog data
from pi's on-disk store and refreshes it only when a client or extension asks.
Model requests, MCP servers, and extension code that ignores `PI_OFFLINE` still
use the network. The environment write is process-wide, so every Manager in the
daemon process inherits the mode.

## Projects and Session Addresses

A Project is static daemon configuration: one canonical, allowlisted directory
and pi's cwd-derived Session storage namespace. The daemon materializes
Projects from `--allow` entries:

- `<path>` derives the id from the canonical real path's basename, in NFC form
  and otherwise verbatim — a Project id is the directory's own name, not a
  slug.
- `<id>=<path>` supplies the id explicitly; the first `=` separates the id
  from the path, so the path may contain `=`.
- The path must exist, resolve to a directory, and be canonicalized with the
  filesystem.
- An id must be non-empty, must not be `.` or `..` (the URL layer resolves
  those away), and must not begin with `@` (the alias namespace, ADR 13). It
  must also be unique, must not collide with a root web-asset path, and two
  Projects must not resolve to the same pi Session storage directory. The id
  is a URL path segment and an address key, never a filesystem path, so no
  further character restrictions apply.

Project configuration is not persisted or discovered from Session files. The
Project id selects the address space and the Project cwd supplies the runtime
working directory. Clients receive Project ids and display cwd values from
`getDaemonInfo`; they do not derive storage paths from ids. The daemon serves
only the configured Projects.

A Session is addressed by `(projectId, stem)`. A stem is the canonical,
forward-slash relative path under the Project's Session directory, without
`.jsonl`. Empty components, `.`, `..`, NULs, absolute paths, drive-letter and
UNC forms, and a terminal `.jsonl` are rejected. Resolution uses filesystem
containment checks, including symlinks, so an existing target or an
intermediate directory cannot escape the Project's Session namespace.

Pi allocates a Session filename before its first flush. Therefore a fresh
Session can have an address and a live Activation before its file exists. A
nested stem remains a relative address, for example `work/review` resolves to
`work/review.jsonl` inside that Project's Session directory.

The durable `sessionId` comes from the pi Session header. It is the cache key,
not the address and not a replacement for the stem. A `SessionRef` combines
`projectId`, `stem`, and `sessionId` for initial sync. The daemon rejects a
`sessionId` claimed by two different `(projectId, stem)` addresses both during
startup scanning and when opening a Session. The storage path and the header
id are intentionally separate: a file can be addressed by its stem while its
header supplies the durable cache identity.

## Manager

`createManager` builds one pi runtime and one canonical Document. It accepts
injected runtime, settings, SessionManager, model, custom tools, and `cwd`
dependencies. The daemon passes `sessionPath` when resuming a durable Session;
without it, pi allocates a fresh, initially unflushed Session. The factory
boundary is also the test seam.

A Manager is never rebound to another Session. Its runtime, Document,
The durable session id, cwd, session file, and creation timestamp all remain those of
the Session selected when it was created. This one-to-one rule prevents one
Connection or a group of Connections from changing the Session served by an
existing Activation.

The Manager applies pi events to its Document and emits patches to registered
listeners. pi is an asynchronous machine: an event describes the item in
flight, while pi's entry list is authoritative. The Manager therefore merges
two inputs through one refresh boundary — `SessionManager.readEntries(from)`
returns the appended entries, the next position, the selected leaf, and a list
version — and never treats an event payload as proof that an entry exists.

A refresh installs each persisted entry under its own id (content, parent,
timestamp, `isSealed: true`, and `ord`), including entries no event announced,
then updates model and thinking level. Context usage is sampled only where it
can move — settle boundaries and attach — because pi derives it from a full
session projection and the per-event refresh runs at token cadence. When the
list version changes — the entry list was replaced wholesale, by a fork — the
refresh re-reads from position zero: the suffix the old position selects
belongs to a list the projection no longer holds. At `turn_end` or
`agent_settled` it also drops live forms that never persisted and re-derives
the recovery kind before notifying settled listeners — except while a recovery
continuation (ADR 16) is still running, whose live forms survive until the
continuation's compensated end. Attach is a refresh before the initial-sync
frame, and it publishes what it discovers to the clients already attached:
the read position advances with the refresh, so an established mirror must
receive the discovery as a patch — nothing would ever resend it. The Manager's
own verbs refresh when they finish, which is how a silent append (a label)
reaches clients. Navigation goes through the same refresh boundary: after the
branch it reads pi's post-branch leaf back, so the leaf, the branch statistics,
and the recovery kind all describe the newly selected branch instead of
leaving the previous branch's totals in place. A suffix that carries a
`session_info` entry re-derives the session name, so a reopened session's
title publishes without a rename event.

For in-flight timing the Manager keeps one bridge-only, in-memory
`toolCallId → start` map. On `tool_execution_start` it stamps the start and
projects `status.inFlightTools[toolCallId]` as the elapsed at emission time;
on `tool_execution_end` it clears the entry. Nothing is persisted or written
back into pi's model — the map exists so a client attaching mid-run, or
reconnecting after the browser closed, recovers the running tool's elapsed
from the initial sync. The client rebases the value onto its own clock, so
host/client clock skew does not leak into the displayed elapsed.

An `entry_appended` payload is an invalidation hint, not content: the entry is
installed by the next refresh, which reads it from pi's list in file order. A
listener that appends while another entry is being published therefore cannot
produce a child whose parent the Document has not installed.

The Manager API has these Session operations:

- `prompt(text, images?)` awaits the completed pi prompt operation.
- `promptAdmitted(text, images?)` resolves at pi preflight admission and lets
the turn continue in the background. The daemon uses this for the first prompt
of `newSession`.
- `executeBash(command, options?)` runs a user `!`/`!!` command in the Session
  cwd and records a `bashExecution` message. The host uses the persisted entry
  as the `user_bash_end` git-stamp boundary.
- `abort` clears queued steering text before waiting for pi to stop.
- `discardSteer` clears queued steering text without aborting the run.
- `setModel`, `setThinkingLevel`, `renameSession`, and `navigate` update the
  Session and refresh or patch the Document as needed. `navigate` is the
  server-side mutation lock enforcement point: it throws while the Document
  is streaming or compacting, because branching swaps the LLM context under
  the in-flight turn (`agent.state.messages` is rebuilt from the new branch);
  the refresh that follows re-derives what the new selection describes.
- `dispose` aborts and flushes the in-flight turn (a recovery continuation
  included), unsubscribes from pi, then drains the git-stamp observation
  scope *before* disposing the runtime: the bundle's `end()` stops admission
  synchronously and resolves only after every queued observation settled, so
  each drained observation appends to a live runtime, no `git` spawn starts
  once teardown proceeds past the scope, and a fire-and-forget trigger
  observation cannot outlive the runtime it appends to. Disposal is
  idempotent and joinable — every caller observes the same teardown.

`addConnection(handle, session, cursor?)` registers one Connection handle and
synchronously emits exactly one initial-sync frame before later live patches.
The frame is a cursor-aware patch when the supplied prefix cursor validates
against the current Session; otherwise it is a full replace. Both initial-sync
forms carry the supplied `SessionRef`. `removeConnection` removes the handle.
The Manager sends unfiltered patches; the Worker's observation applies the
lazy-demand filtering when it forwards them.

Each Manager bundles the hidden `pi-bridge.git-stamp` extension once. The
bundle remains bound to that Manager's runtime and its host trigger never
switches to another Session. Git-stamp writing is enabled by default and can
be disabled with `gitStamps: false`, primarily for tests. The complete stamp
contract is in [git-stamps.md](git-stamps.md).

## The Session actor

`src/host/session-actor.ts` is the one owner of one Session's runtime
lifetime: the Manager and its canonical Document, command admission,
observation registration, and terminal teardown, behind one phase state
machine (`creating → live → closing → closed`). Clients reach the runtime
only through a `SessionCapability` the actor issued — the registration
identity, the two admission classes, observation registration, and a
joinable release — and every observation is its own independently
releasable `ObservationCapability`. The Manager stays private to the actor:
the daemon's listing reads go through `metadata()` (the typed facts derived
from the canonical Document), and raw Manager access belongs to the creation
paths only — the factory, the stem derivation, and the pre-attach choices in
the local Worker's fresh-session choreography. That pre-registration window
is the one sanctioned raw access: the runtime has no owner to admit work
through until the actor exists. The actor is created around a built runtime,
so its phase begins `live`; `creating` names that window.

Work arrives in two admission classes, and the classes exist because the
bridge must not add a competing turn lifecycle (architecture invariant 5:
pi's event loop is serial and the bridge observes it):

- **Mutations** (`setModel`, `setThinkingLevel`, `renameSession`, `setLabel`,
  `navigate`) are serialized among themselves — one at a time, in admission
  order — so concurrent commands from different Connections get a
  deterministic order. Mutations are quick and never await a turn, so the
  line cannot deadlock behind streaming.
- **Immediate work** (turns — `prompt`, `recoverTurn` — plus `abort`, and
  reads — `pull`, `gitShow`'s cwd) runs without queueing: a Stop must reach a
  streaming turn rather than wait behind it, and a read that queued behind a
  turn would stall the live pulls the client issues while content streams.
  Immediate work is tracked, so the terminal drain accounts for it.

`close` is the terminal boundary: admission stops synchronously, queued
mutations reject, the runtime is disposed exactly once (its disposal aborts
and finalizes the in-flight turn, which settles the tracked work admitted
against it), every tracked operation is awaited, and every live observation
is released after the drain — they owned delivery of the teardown's final
patches, so nothing registered through a capability outlives the actor's
tear-down. Registry collection and daemon shutdown both close through it,
so a Manager is disposed exactly once regardless of which path terminates
it.

## Connection

A Connection owns exactly one WebSocket. It starts detached and holds at most
one attachment: a `SessionTarget` (the address, the durable session id, the
Worker registration, and the activation generation), the Worker observation
delivering its Document, and the `SessionCommands` bound to that target. The
Connection never holds a Manager or an admission object, so a command cannot be
written that bypasses the owner's check.

`attach(open)` is the one attachment path. The Connection mints the next
attachment generation, hands `open` the frame sink, and only then records what
the transition produced — so an initial sync emitted during acquisition already
names the new attachment, and a failed open leaves the previous attachment
installed. The predecessor observation is released before `attach` resolves.
`detach` releases the observation without disposing the Activation.

Commands are target-addressed: `src/host/session-commands.ts` binds the typed
verbs to the target they serve, and the owning Worker resolves the target to the
registration that still holds that activation generation and durable session
id. A command admitted before its Activation ended still completes against the
runtime it captured; one that names a replaced activation, a replaced
registration, or a different Session at the same address is refused — never
retargeted at the successor. That is what lets the reply the client trusts
describe the Session the request named. A socket close disposes the Connection
and releases its observation.

Initial-sync frames are the observation's full state and clear its demand;
every observation frame the Connection emits — initial sync, live patch, and the
terminal `session_closed` — is stamped with the current attachment generation
(ADR 19), and frames are plain JSON envelopes (there is no transport
compaction, because a compacted frame cannot name its owner). Live patches are
already filtered when the Connection receives them: each observation filters
the Manager's stream against its own demand — the paths it pulled while the
entry was live — so a Connection never holds a subscription set and a second
observation of the same Session receives exactly what it asked for. A `pull`
reads through the attached observation and registers that demand.

Attachment changes mint the next **attachment generation** (ADR 19): every
observation frame the Connection emits — the initial sync, live patches, and
the terminal `session_closed` the registry hands it after detaching it
(`pushSessionClosed`) — names the attachment whose stream it belongs to, and
a `pull` reply names the generation current when its request was admitted.
The client mirror admits a live frame only while it matches the established
generation, so a frame from an older attachment cannot touch the successor's
state even when the address is unchanged; the rule and the wire field are
specified in [core protocol](../core/protocol.md).

The Connection demultiplexes RPC frames by verb. Every verb that is not an
attachment transition is a typed handler in
`src/host/connection-verbs.ts`: a seam function that validates the request
shape, captures its target at handler entry (before any await), and replies
through a `VerbContext` exposing only the daemon seam, the attachment
target-bound commands, and the reply path — no socket, no transition state,
no runtime. Attached Session verbs are:
`prompt`, `abort`, `discardSteer`, `setModel`, `setThinkingLevel`,
`renameSession`, `setLabel`, `navigate`, and `recoverTurn`. They require an
attachment and are issued through the target-bound commands — the two
admission classes (immediate commands, serialized mutations) are the
Session actor's. Each handler captures the target at handler entry,
before any await, so a transition
that completes while the command runs cannot retarget it: the command
executes against, and reports on, the session attached when the request
arrived. The host validates prompt image envelopes and enforces the shared
image-count and image-size limits.

Navigation verbs are `openSession`, `newSession`, `detach`, `closeSession`,
and `archiveSession`. They route to the Daemon because they change attachment
or Activation state. The three that change this Connection's attachment —
`openSession`, `newSession`, and `detach` — are serialized: each runs to
completion before the next begins, in arrival order, so concurrent
transitions cannot each decide which Manager ends up attached, and the reply
the client trusts describes the same operation as the attachment the server
keeps. A disposed Connection refuses admission: a transition that arrives
after the socket closed, or that reaches its turn after it, replies with an
error instead of attaching something nothing would ever release. The
serialization and that refusal are one `LifecycleScope`
(`src/host/lifecycle-scope.ts`): disposal closes it synchronously — queued
transitions answer `connection closed` — and drains one still in flight
before the Connection is gone. `dispose()` is that drain (idempotent, awaited
by the daemon's teardown), so the sentence is enforced, not aspirational: the
daemon snapshots the Connections, stops the server, and awaits each drain
before it disposes Session execution.
`closeSession` and `archiveSession` change Activation state, not this
Connection's attachment, and are not serialized against it. Query verbs are `listSessions`, `listActiveSessions`,
`getDaemonInfo`, `listFiles`, `readFile`, `listDirectory`, `gitShow`,
`gitBase`, and `gitDiff`. `listFiles` is Project-addressed; `readFile`,
`listDirectory`, `gitBase`, and `gitDiff` are absolutely addressed (ADR 14),
so their base travels in the request and they need no attachment. `gitShow`
alone remains attachment-bound: it reads the attached Session's Project cwd.
`pull` is Connection-local: it reads the attached observation's lazy values
and registers the live (unsealed) paths as that observation's demand, so later
patches on those paths keep flowing. `console` is
accepted only when the daemon is in
dev mode and is a no-op acknowledgement.

RPC replies carry the request id and success or error fields. Document changes
never ride in replies: they arrive through initial-sync or live push frames.
The daemon can also use `push` on a Connection for registry broadcasts.

## Activation Registry

`src/host/activation-registry.ts` is the index and reservation layer around
the Session actors, behind the local Worker (the Daemon never touches it
directly). The runtime lifetime of each Activation — admission,
observations, terminal teardown, and the idle-collection decision — belongs
to its Session actor (`src/host/session-actor.ts`); the registry owns what
is addressed rather than run:

```text
absent -> creating -> live -> collecting -> absent
```

describes the address. It maintains the Activation records (keyed by
daemon-local id), the address
index keyed by `(projectId, stem)`, pending-creation promises keyed by the
same address, and the `sessionId` ownership index. These are implementation
state and never cross the wire; attachment is the Worker's observation table,
not the registry's. The Worker supplies the Manager factories (open and
create), the idle-collection delays, the pre-clamp thinking-level read, and the
broadcast hooks (settlement, streaming transitions, registration/collection),
and reports changes as Worker events the Daemon forwards. The settlement and streaming hooks ride the actor's own
observation of its runtime — the registry's records carry no runtime state.
Each registration carries its authorization (`incarnation` +
`generation`), assigned here and never reused within the incarnation.

A registration's terminal fact is its actor's phase: `collect` invokes the
actor's close synchronously before its first await, so the phase flips to
`closing` — and every liveness check refuses the record — from the instant
collection begins, with no separate registry flag. A stale handle reaching
`collect` is therefore refused — it owns nothing anymore, neither the address
nor the durable-id claim — and can neither double-dispose the runtime nor
release a newer registration's claims. The durable session id is released by
record identity, not address fields, so only the registration that still
holds a claim can drop it. Termination is also joinable: a `collect` call
that finds a disposal already in flight awaits it (`collecting` — the
actor's close plus the registry's index cleanup — is cleared only when both
completed), so every caller observes the same completion — `archiveSession`
relies on this to move a session file only after its Manager finished
dying, not merely after its death began.

Shutdown is a terminal state. `dispose()` sets the flag and clears every
index in one synchronous block — so a record is either in the drain's
snapshot or its registration is refused — then drains: in-flight creation
promises are awaited (their registration refuses and disposes the Manager the
factory produced), in-flight collections are awaited, and every remaining
Manager is disposed exactly once. The drain is memoized: a second `dispose()`
joins the first caller's promise instead of returning on the flag, so
"shutdown completed" means the same thing to every caller. Fresh-session
creation is tracked too
(`runCreation`): it builds a Manager whose address does not exist until the
file is allocated, so it cannot ride the per-address pending map, but the
drain awaits the whole Manager-owning operation — including the disposal a
refused registration performs inside it. After the flag, no admission acts:
`reserve` and `register` refuse, `attach` refuses, and `collect` is a
no-op (the drain owns those records). A factory that completes after
shutdown can therefore neither register an Activation, leak a Manager, nor
outlive the drain's return.

Opening an address is resolve-or-create. An existing live Activation is
reused; the observation the following attach installs is what keeps its actor
alive, and the actor's fire-time re-check covers the reservation window. An
in-flight creation is shared by
other opens for the same address. A collecting Activation is awaited and the
address is retried after disposal, which prevents a GC race from creating a
second Manager. Otherwise the daemon resolves the contained stem, creates a
Manager through the injected factory, checks the header `sessionId` owner, and
registers a new Activation. Reserving and attaching are one registry
operation: a close that lands between them makes the open re-reserve instead
of attaching a collected record, and the registry refuses to attach a
collecting record outright. The Connection is then attached to that Manager
with its optional cursor.

`closeSession` and `archiveSession` see the same address state an open does:
both first wait out a creation in flight for the address
(`awaitSettled`), because acting on the registered state alone could report
"not active" — or move the session file — while a Manager for that address is
still being constructed, and the completing creation would then register
against an address whose lifetime had already been decided.

An Activation never serves another Session. Several Connections may share one
Activation, while each Connection has at most one attachment. Attaching a
Connection releases its former daemon attachment first, so a Connection move
cannot leave two registry references behind. If a socket closes while an open
or new-session operation is still in flight, the daemon does not attach the
disposed Connection and arms the actor's idle timer for the orphaned
Activation.

## Activation Collection

The idle decision belongs to the Session actor: a live observation's capability is an
attached client and keeps it alive, the fire-time check defers while the
runtime streams or compacts, and a durable Session, or an empty unflushed
Session, waits `idleGcMs` (default five minutes) while an unflushed Session
that already has entries waits `unflushedIdleGcMs` (default thirty minutes,
because disposing it can drop entries that have not reached disk). These
delays are daemon policy, passed to the actor through the registry, and are
injectable for tests, not client configuration.

When the actor reports idle, the registry runs the collection choreography
under the same `collecting` reservation `openSession` uses: the actor's
close, the address held reserved through the async disposal, the Activation
and Session ownership index removal, the detach-and-notify loop over every
attached Connection (the terminal ownership boundary below), and the
resulting active-session snapshot broadcast. Collection never deletes a
Session file.

`closeSession(projectId, stem)` is an explicit kill, not idle collection. It
normalizes and resolves the Project address, waits out a creation in flight
for it, requires an active non-collecting Activation, and immediately uses
the same collect/dispose path regardless of attached Connections, streaming
state, or idle policy. It then refreshes the Project's first session page.
Collection is also the terminal ownership boundary: every Connection
attached to the address is detached — its Manager handle and attachment
fields are severed — and each receives a `session_closed` push
(`projectId`, `stem`) after the disposal's final patches and before the close
reply. A session command that arrives afterwards fails with `no session
attached` instead of reaching a disposed runtime, and a client rendering the
closed Session lands on its Project home. Idle collection never has an
attached Connection to notify, and daemon shutdown skips the frame (the
sockets are closing with the process).

`archiveSession(projectId, stem)` closes a Session, then moves its file under
the reserved `.archive` prefix of the Project's session directory. It first
waits out a creation in flight for the address, then closes — unconditionally,
using the same collect/dispose path as `closeSession` when an Activation
exists; a dormant Session has none, so only the move happens. The move follows
disposal because disposal finalizes an in-flight turn, which can create or
advance the file. An archived Session is neither
discovered nor addressable: the scanner and the startup `sessionId` conflict
scan skip the prefix, and `normalizeStem` rejects it. The verb refreshes the
Project's first page; when it had an Activation, the active-session snapshot
broadcast from collection covers that side, and its attached Connections are
detached and notified exactly as `closeSession` does. A missing durable file (a fresh
Session whose first turn never flushed) is an error reply — the close still
happened, but nothing was archived.

The timer model and its reservation invariant govern this runtime.

## Session Operations

### `newSession`

`newSession` requires a non-empty text prompt, a Project id, and an
`operationId` minted by the client's selection owner (a missing id is refused
before anything is created). The
execution link creates a fresh Manager, derives its allocated stem from the
Manager's session
file, and registers the Activation. Before attaching the Connection it applies
an optional `model` and `thinkingLevel`, then calls `promptAdmitted` with the
text and optional images. A `model` pick without a `thinkingLevel` gets one
explicitly — the chain a fresh session on that model would resolve (per-model
override, else the settings default, else pi's `DEFAULT_THINKING_LEVEL`),
clamped to the model — so a pick never inherits the placeholder default
model's clamped level from `setModel`'s re-derivation. Events that arrive
before attachment remain in the canonical Document and are covered by the
synchronous initial sync.

The Connection stamps the request's `operationId` onto the transition's
initial-sync frame and reply: the attach (which emits the frame) is
synchronous inside the serialized transition, so the attribution window is
exact — only that creation's frame carries the id, and a later transition
cannot. The id is the client's admission handle for the frame, not server
state.

If model selection is unknown or prompt admission fails, the fresh Activation
is disposed and the RPC returns an error; no empty Session is left behind. On
success the Connection attaches with no cursor and receives its initial sync,
then the RPC returns the `SessionRef`. The Project home can hold a client-side draft, but daemon Session creation
always has a first message.

### `openSession`

`openSession` takes a Project id, normalized stem, and optional prefix cursor.
It resolves or creates the address, waits through any collecting Activation,
and attaches the Connection to the resulting Manager. It is not a
transactional switch: the Connection releases its existing attachment before
the new attach is completed. A failed open returns an error from the Daemon.

### `archiveSession`

`archiveSession` takes a Project id and a normalized stem. It looks up the
address's Activation and collects it when one exists — a close, not a GC, so
streaming state and attached Connections do not defer it. It then moves
`<sessionDir>/<stem>.jsonl` to `<sessionDir>/.archive/<stem>.jsonl`, creating
the archive directory tree. Both the source and the destination directory are
containment-checked, so a symlinked `.archive` cannot redirect the move
outside the Project namespace. The move refuses to overwrite an existing
archived file. The Session file survives; it merely leaves discovery, and
moving it back is a manual filesystem operation.

### `detach`

`detach` releases the Connection's registry attachment but leaves its
Activation available for later opening or idle collection. It sends only the
RPC acknowledgement; the Activation remains live until the collection policy
allows disposal.

### Session listing

`listSessions(projectId, max?, cursor?)` recursively scans the Project's
contained `.jsonl` files and overlays live Activations, so an unflushed live
Session is included. A live entry wins over a disk row for the same stem. Rows
are ordered by descending file mtime, with the in-memory Session-header
creation time used before first flush; equal times are ordered by descending
canonical stem. The cursor is exclusive and compound: `{ sortTimeMs, stem }`.
The reply reports `sessions`, `hasMore`, and the last row as `nextCursor`.

`SessionInfo` carries `projectId`, durable `sessionId` when known, stem,
`active`, `isStreaming`, timestamp, and available name, first-message text,
latest-message preview, message count, and last-activity time. A durable file
supplies metadata; an unflushed active Session supplies the actor's
`metadata()` — the typed read surface over the canonical Document. For
an active row the live latest-message preview and last-activity time win over
the file scan; `timestamp` remains the durable sort key (mtime / header
creation). `listActiveSessions` uses the Activation
registry instead of a disk scan, is global across Projects, is not paginated,
and returns the same row shape ordered by timestamp.

`getDaemonInfo` returns the static Project list, per-Project fresh-session
model and thinking defaults, available model metadata, the daemon-global
`pinnedModels` list resolved from pi's global `enabledModels`, the
normal-tier `visibleModels` keys resolved from the bridge settings file,
supported thinking levels, and dev-mode state. Model defaults are resolved
from each Project's settings and the shared model runtime; they are display
data and do not pin a future `newSession` request when the client omits an
override. The thinking level is the pre-clamp resolution (per-model override
for the default model, else the settings default, else pi's
`DEFAULT_THINKING_LEVEL`); the client clamps it to the displayed model's
supported levels, which is the level the session runs at. One known gap: a
per-model thinking-level override (`modelThinkingLevels` in pi settings) for
a model the Project home *picked* — rather than the default — is host-side
state the reply does not carry, so the display ignores it while the session
runs at the override. Pinned models is one daemon-global concept (ADR 15): a project-level
`.pi/settings.json` `enabledModels` override is not reflected, and the
`setModelPinned` verb writes the same global list (broadcasting
`pinned_models_changed`). The verb is a read-modify-write over that list, so
its mutations are serialized daemon-wide — one at a time, in arrival order,
across every Connection — or two concurrent pins would each read the
pre-mutation list and the later flush would silently drop the earlier
update.

### Files and repository detail

`listFiles(prefix, projectId)` is attachment-free. It resolves completion
against the named Project's cwd, returns at most forty matching entries, marks
directories, sorts directories first, and omits hidden entries unless the
prefix begins with `.`. This Project-addressed form is what the Project-home
composer uses before a Session exists.

`readFile` and `listDirectory` are the browser's content and structure
queries (ADR 14). Both are attachment-free and absolutely addressed: the
request carries the path, so no Session is needed to resolve a base, and a
Connection that never opened one can still browse. `~`-rooted paths are the
one non-absolute form accepted, expanded host-side because the client has no
HOME; everything else must be absolute. For a snapshot state the host finds
the repository containing the path (from the nearest existing directory
ancestor, so a deleted path still resolves) and translates the path to a
repository-relative one — `<rev>:<rel>` or `:<rel>` for the index — running
git from the repository root. A path outside a repository has no snapshot
view and is `absent`.

`readFile` returns one path's content at one state. `"worktree"` reads the
filesystem fresh; a pinned oid or `"head"` reads the commit's tree, and
`"index"` reads the staged blob. All states cap content at 256 KiB and report
the path, original byte count, and truncation flag. A missing path is a value,
not an error: the reply is `absent` for a deleted file, a path not in a
commit's tree, a directory (`cat-file blob` rejects a tree), or an unmerged
index entry. Binary content (a NUL byte in the first 8 KB) is reported as
`binary` rather than decoded. A state that does not resolve is an error, not
an absent path: a failed blob read is only called `absent` after the state
itself is verified (`rev-parse <rev>^{tree}` for a commit, `ls-files` for the
index), so an unreachable recorded commit or an unreadable index stays a
failure.

`listDirectory` returns one directory's immediate children. Live listings read
the filesystem; `"head"`/commit listings use non-recursive `git ls-tree`, and
`"index"` listings derive immediate children from the flat staged path list
(the index holds no tree objects). `.git` is never listed — machine state, not
project content — and entries are capped at `MAX_DIRECTORY_ENTRIES` with the
remainder reported as `omitted`. A missing directory, or a snapshot state for
a path outside a repository, is `absent`. A listing that cannot be read at all
— an unreadable state, a spawn failure, an index listing over its byte cap —
is an RPC error, never an empty directory, so the client can say the directory
is unreadable and retry it on the next expansion. Listing is lazy: one
directory per expansion, never a recursive scan.

`gitShow` is attachment-bound and runs `git show --stat --no-color` in the
attached Manager's cwd. The commit must be a 40- or 64-character lowercase
hex object id. The command has a five-second timeout and a 128 KiB output cap;
invalid, unreachable, failed, or timed-out requests return an RPC error. This
is an explicit viewer query, not part of automatic Document synchronization.

`gitBase` resolves the comparison base for reviewing one commit: the first
parent's oid, or the repository's empty-tree oid when the commit is a root
commit, so a commit card can open the browser on `commit` vs `base` without
the client knowing git's parent syntax or a hash-algorithm constant. It is
attachment-free and scoped by an absolute directory, like `gitDiff`. An
unreachable commit is an RPC error; the empty-tree oid is an internal diff
base, never offered as a picker value.

`gitDiff` is the browser's *directive* query: it returns the file list,
statuses, and line counts between two states — a pinned object id, `"head"`
(the repository's current HEAD, resolved at query time), `"index"`, or
`"worktree"` (valid only as the new state) — and never patch text. It is
attachment-free and scoped by an absolute directory. Two directives are run
per query: `git diff --numstat -z` is the authority for which files are
listed, and `git diff --raw -z` supplies the status letters (added, modified,
deleted, renamed, copied, typechange, unmerged). Both use fixed flags
(`--no-color --no-ext-diff --no-textconv -M --relative --literal-pathspecs`)
so repo config cannot alter the output. `--relative` (explicit, so it
overrides `diff.relative` config) makes every path relative to the requested
directory and scopes the directive to that subtree. The three trees make the
state pair a matrix rather than a symmetric pair: `--cached` compares against
the index, and an index-valued base is the reverse (`-R`) of the canonical
commit → index diff. A worktree-side diff also lists untracked, non-ignored
files, which git's own diff never reports: they are enumerated with
`ls-files --others --exclude-standard` (directory-relative, so the same base),
capped at `MAX_UNTRACKED_FILES` with the remainder reported as
`untrackedOmitted`, and carry no line counts. The changed-file list itself is
capped at `MAX_DIFF_FILES` with the remainder reported as `filesOmitted`.
Each directive stream is byte-capped as a memory guard (16 MiB — hundreds of
thousands of `numstat` records, far above a realistic diff). A byte-truncated
`numstat` cannot supply an exact `filesOmitted`, so it is refused as an RPC
error rather than presented as a partial list; a truncated `raw` stream is not
fatal, and the status letters past the cut fall back to `unknown`. State values
are validated before any spawn: only the exact sentinels and lowercase hex
oids are accepted, and `"worktree"` is invalid as the old state.

The content half of the browser is `readFile` (above): each file section
fetches both ends of the pair and diffs them in the client. There is no patch
parser and no patch byte cap; a truncated snapshot is refused for diffing
rather than rendered as a phantom tail. Like `gitShow`, failures and timeouts
are RPC errors; the browser is read-only — no verb here mutates the repository
or the index.

### Bridge settings and model visibility

The daemon reads `<agentDir>/bridge/settings.json` on each `getDaemonInfo`
(ADR 15). It is a bridge-owned preferences file, separate from pi's
`settings.json`, so bridge needs no pi setter. Its `visibleModels` field is an
array of canonical `provider/modelId` minimatch patterns, matched
case-insensitively against the full `provider/modelId` reference. `/` is a path
separator, so `*` stays within a segment and `**` crosses them: `deepseek/*`
selects the models DeepSeek serves and never an OpenRouter-routed model, while
`**/claude-*-5*` reaches a routed `openrouter/anthropic/claude-…`. A pattern
without `/` matches nothing. An optional `:thinkingLevel` suffix is stripped.
The daemon resolves the patterns against the catalogue it already reports and
returns the matched `provider/modelId` keys as `visibleModels` on the reply.

A missing, unreadable, or malformed file, an absent key, or an empty array
means no filter: every non-pinned model is normal. There is no watcher, so an
edit is picked up at the next `getDaemonInfo`. The daemon never writes the
file; the preference is hand-edited until an editing verb exists.

## Pushes and HTTP Serving

A `sessions_changed` push is Project-scoped. It contains the Project id and a
fresh first page of up to ten `SessionInfo` rows, with its pagination flags
and cursor. The Daemon publishes it after a Session settles, after a rename,
and after explicit close disposal; a settle also refreshes metadata when a
fresh Session first reaches disk.

An `active_sessions_changed` push is global. It contains the complete current
`listActiveSessions` snapshot. The Daemon sends it when an Activation is
registered or collected and when a Manager's streaming state changes; settled
listeners also refresh it. Connections receive these pushes regardless of
which Project they currently have attached.

The Daemon serves the built web assets and the SPA shell from one
`AssetSource` — the disk web root in development, the base64 map inlined at
bundle time in the single-file binary. The HTTP routing is identical for both;
only the I/O differs. A request whose first path segment is a top-level entry
of the asset surface (a build output name, plus vite's `assets/`) is a
resource: a miss is a 404, and a traversal under the root is rejected by the
source's containment check before any read. Every other path is a client
address: the Daemon returns the shell and the web client resolves it, so an
unknown Project or alias lands on the launcher rather than a 404. Project ids
colliding with root asset names are rejected at startup so an asset cannot hide
a Project route. The shell, the install manifest, and `favicon.svg` are served
`Cache-Control: no-cache` — each has to revalidate so a redeploy is not masked
on an installed client; content-hashed `assets/` entries are immutable, and
`icons/` (unhashed, written by the web build) gets a day of `max-age`. The
manifest's own MIME type is `application/manifest+json`; served as
`application/octet-stream` Chromium silently treats the app as non-installable.
The same process owns the WebSocket server
used by Connections.

The web client turns these frames into URL-driven navigation and a Document
mirror; the overall layer relationship is described in
[architecture](../architecture.md).

## Third-Party Services

Two daemon-global verbs reach endpoints the browser cannot. Neither is scoped to
an attachment, and neither puts a credential on the wire.

`asrCredentials` hands the page what it needs for dictation: a registered device
id (the default, and shared rather than secret) or a SAMI token minted from
`DOUBAO_ACCESS_KEY` when the operator sets it. The ASR stream itself runs from
the browser to the endpoint, so the socket carries only the credential.

`textPolish` is the opposite arrangement: the daemon speaks the whole protocol
(WeChat IME `Kb-CmdId: 4549`, see `src/host/text-polish.ts`) and only the draft
crosses the socket. That sends user text to a third party, so nothing runs
speculatively: the composer asks only from a press whose tooltip names the
destination, and the answer is kept only as the toolbar's undo. The guest
identity is a private key: it lives at
`<agentDir>/bridge/wxime-identity.json` (override
`BRIDGE_TEXT_POLISH_IDENTITY`), mode `0600`, minted on first use and never
rewritten when a file already exists. One exchange runs at a time — the service
rate-limits a `uin` — and each request carries a 15 s abort timeout.
