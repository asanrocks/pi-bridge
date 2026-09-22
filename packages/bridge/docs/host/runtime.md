# Host Runtime

The host is the Node-side owner of live Sessions and the WebSocket protocol. A
Daemon owns static Projects, live Activations, and Connections. An Activation
contains one Manager and serves exactly one Session for its entire lifetime.
Activations are daemon-internal; the wire carries Session addresses and
references, never an Activation.

The canonical Session content is a `Document` owned by its Manager. The
Document and its patch protocol are defined in [the core data model](../core/data-model.md).
The host's initial-sync and lazy-field behavior uses the wire contract in
[core protocol](../core/protocol.md); this document covers the host ownership
and routing around that contract.

## Projects and Session Addresses

A Project is static daemon configuration: one canonical, allowlisted directory
and pi's cwd-derived Session storage namespace. The daemon materializes
Projects from `--allow` entries:

- `<path>` derives the id from the lowercase basename of the canonical real
  path.
- `<id>=<path>` supplies the id explicitly; the first `=` separates the id
  from the path, so the path may contain `=`.
- The path must exist, resolve to a directory, and be canonicalized with the
  filesystem.
- An id must match `[a-z0-9]+(?:-[a-z0-9]+)*`, must be unique, and must not
  collide with a root web-asset path. Projects that resolve to the same pi
  Session storage directory are rejected.

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
listeners. At `turn_end` or `agent_settled` it reconciles against the durable
pi entries, updates live model, thinking, and context data, and then notifies
settled listeners. Reconcile seals provisional entries and assigns durable
entry positions. Idle model, thinking-level, and rename operations reconcile
when necessary; navigation updates the Document leaf directly so it preserves
the selected branch.

An `entry_appended` whose parent chain does not resolve in the Document is
not applied live. Mid-turn, the streaming assistant is a `pending:message`
provisional while pi has already persisted it under its real id, so an
append at that boundary (the git-stamp `tool_end` anchor) parents on an id
the Document does not know; applying it would move the leaf onto an
unresolvable chain and collapse the leaf path. Such entries defer to the
seal, which discovers them from the durable entries like any other
silently-appended entry. Known-parent appends — prompt stamps, bash entries,
and their `user_bash_end` stamps — still apply live.

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
  Session and reconcile or patch the Document as needed. `navigate` is the
  server-side mutation lock enforcement point: it throws while the Document
  is streaming or compacting, because branching swaps the LLM context under
  the in-flight turn (`agent.state.messages` is rebuilt from the new branch).
- `dispose` aborts and flushes the current runtime, unsubscribes from pi, and
  disposes the runtime.

`addConnection(handle, session, cursor?)` registers one Connection handle and
synchronously emits exactly one initial-sync frame before later live patches.
The frame is a cursor-aware patch when the supplied prefix cursor validates
against the current Session; otherwise it is a full replace. Both initial-sync
forms carry the supplied `SessionRef`. `removeConnection` removes the handle.
The Manager sends unfiltered patches; each Connection applies its own lazy
subscription filtering.

Each Manager bundles the hidden `pi-bridge.git-stamp` extension once. The
bundle remains bound to that Manager's runtime and its host trigger never
switches to another Session. Git-stamp writing is enabled by default and can
be disabled with `gitStamps: false`, primarily for tests. The complete stamp
contract is in [git-stamps.md](git-stamps.md).

## Connection

A Connection owns exactly one WebSocket. It starts detached and can be attached
to at most one Manager and one `SessionRef` at a time. `attach` first detaches
any current Manager, records the new Session reference, resets the
connection-local `CompactCodec`, and asks the Manager for initial sync.
`detach` removes the Manager handle and clears the attached Session reference.
A socket close disposes the Connection and releases its daemon attachment.

The codec reset is part of attachment correctness: an append-compression path
remembered for one Session must not be reused for another. Initial-sync frames
are sent unfiltered and clear lazy subscriptions. Live patches are filtered by
those subscriptions before the Connection sends them. A `pull` request reads
values from the attached Manager's canonical Document; pulling a provisional
lazy path also registers that path for subsequent live patches.

The Connection demultiplexes RPC frames by verb. Attached Session verbs are:
`prompt`, `abort`, `discardSteer`, `setModel`, `setThinkingLevel`,
`renameSession`, and `navigate`. They require an attachment and route to that
Manager. The host validates prompt image envelopes and enforces the shared
image-count and image-size limits.

Navigation verbs are `openSession`, `newSession`, `detach`, `closeSession`,
and `archiveSession`. They route to the Daemon because they change attachment
or Activation state. Query verbs are `listSessions`, `listActiveSessions`,
`getDaemonInfo`, `listFiles`, `readFile`, and `gitShow`. `listFiles` is
Project-addressed and needs no attachment. `readFile` and `gitShow` require an
attachment because their relative path or repository is the attached
Session's Project cwd. `pull` is Connection-local. `console` is accepted only
when the daemon is in dev mode and is a no-op acknowledgement.

RPC replies carry the request id and success or error fields. Document changes
never ride in replies: they arrive through initial-sync or live push frames.
The daemon can also use `push` on a Connection for registry broadcasts.

## Activation Registry

The Daemon starts with Projects but no Activations. It maintains:

- an Activation registry keyed by daemon-local activation id;
- an address index keyed by `(projectId, stem)`;
- pending activation promises keyed by the same address;
- the `sessionId` ownership index; and
- the Connection-to-Activation attachment index.

These registries are implementation state and never cross the wire.

Opening an address is resolve-or-create. An existing non-collecting Activation
is reused and its idle timer is cancelled. An in-flight creation is shared by
other opens for the same address. A collecting Activation is awaited and the
address is retried after disposal, which prevents a GC race from creating a
second Manager. Otherwise the daemon resolves the contained stem, creates a
Manager through the injected factory, checks the header `sessionId` owner, and
registers a new Activation. The Connection is then attached to that Manager
with its optional cursor.

An Activation never serves another Session. Several Connections may share one
Activation, while each Connection has at most one attachment. Attaching a
Connection releases its former daemon attachment first, so a Connection move
cannot leave two registry references behind. If a socket closes while an open
or new-session operation is still in flight, the daemon does not attach the
disposed Connection and arms normal idle collection for the Activation.

## Activation Collection

An idle Activation is collected only when it has no attached Connections. The
collection check also defers while the Manager is streaming or compacting. A
durable Session, or an empty unflushed Session, uses `idleGcMs`, whose default
is five minutes. An unflushed Session that already has entries uses
`unflushedIdleGcMs`, whose default is thirty minutes because disposing it can
drop entries that have not reached disk. These delays are daemon policy and
are injectable for tests, not client configuration.

The timer callback rechecks attachment and streaming state under the same
`collecting` reservation used by `openSession`. Collection calls the shared
Manager disposal path, keeps the address reserved through async disposal,
removes the Activation and Session ownership indexes, clears Connection
bookkeeping, and broadcasts the resulting active-session snapshot. Collection
never deletes a Session file.

`closeSession(projectId, stem)` is an explicit kill, not idle collection. It
normalizes and resolves the Project address, requires an active non-collecting
Activation, and immediately uses the same collect/dispose path regardless of
attached Connections, streaming state, or idle policy. It then refreshes the
Project's first session page. The current host protocol does not emit a
`session_closed` push: attached sockets are not actively notified or detached
by this operation, and a client must reconnect or navigate to obtain a fresh
attachment. No `session_closed` frame is part of the implemented
`ServerPushMessage` set.

`archiveSession(projectId, stem)` closes a Session, then moves its file under
the reserved `.archive` prefix of the Project's session directory. The close
is unconditional and uses the same collect/dispose path as `closeSession`
when an Activation exists; a dormant Session has none, so only the move
happens. The move follows disposal because disposal finalizes an in-flight
turn, which can create or advance the file. An archived Session is neither
discovered nor addressable: the scanner and the startup `sessionId` conflict
scan skip the prefix, and `normalizeStem` rejects it. The verb refreshes the
Project's first page; when it had an Activation, the active-session snapshot
broadcast from collection covers that side. A missing durable file (a fresh
Session whose first turn never flushed) is an error reply — the close still
happened, but nothing was archived.

The timer model and its reservation invariant govern this runtime.

## Session Operations

### `newSession`

`newSession` requires a non-empty text prompt and a Project id. The Daemon
creates a fresh Manager, derives its allocated stem from the Manager's session
file, and registers the Activation. Before attaching the Connection it applies
an optional `model` and `thinkingLevel`, then calls `promptAdmitted` with the
text and optional images. Events that arrive before attachment remain in the
canonical Document and are covered by the synchronous initial sync.

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
supplies metadata; an unflushed active Session supplies the live Document. For
an active row the live latest-message preview and last-activity time win over
the file scan; `timestamp` remains the durable sort key (mtime / header
creation). `listActiveSessions` uses the Activation
registry instead of a disk scan, is global across Projects, is not paginated,
and returns the same row shape ordered by timestamp.

`getDaemonInfo` returns the static Project list, per-Project fresh-session
model and thinking defaults, available model metadata, the daemon's global
`enabledModels` scope, supported thinking levels, and dev-mode state. Model
defaults are resolved from each Project's settings and the shared model
runtime; they are display data and do not pin a future `newSession` request
when the client omits an override. The scope is global settings only — a
project-level `.pi/settings.json` override is not reflected — and exists so the
Project home can render curated models before a Session (and its Document)
exists; an attached Session's own scope arrives with its initial sync.

### Files and repository detail

`listFiles(prefix, projectId)` is attachment-free. It resolves completion
against the named Project's cwd, returns at most forty matching entries, marks
directories, sorts directories first, and omits hidden entries unless the
prefix begins with `.`. This Project-addressed form is what the Project-home
composer uses before a Session exists.

`readFile` is attachment-bound and reads the requested file fresh against the
attached Manager's cwd. It accepts absolute paths and relative paths (with
`~` expansion), requires a regular file, caps returned content at 256 KiB, and
reports the absolute path, original byte count, and truncation flag.

`gitShow` is attachment-bound and runs `git show --stat --no-color` in the
attached Manager's cwd. The commit must be a 40- or 64-character lowercase
hex object id. The command has a five-second timeout and a 128 KiB output cap;
invalid, unreachable, failed, or timed-out requests return an RPC error. This
is an explicit viewer query, not part of automatic Document synchronization.

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

The Daemon serves the SPA shell at `/` and at `/<projectId>` or
`/<projectId>/<stem...>` for configured Projects. Embedded assets are used
when available; otherwise assets are read from `webRoot` or the built web
root. Asset paths are served before application routes, the web root is
containment-checked, and unknown paths return 404. Project ids colliding with
root asset names are rejected at startup so an asset cannot hide a Project
route. The same process owns the WebSocket server used by Connections.

The web client turns these frames into URL-driven navigation and a Document
mirror; the overall layer relationship is described in
[architecture](../architecture.md).
