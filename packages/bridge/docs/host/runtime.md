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
`getDaemonInfo`, `listFiles`, `readFile`, `listDirectory`, `gitShow`,
`gitBase`, and `gitDiff`. `listFiles` is Project-addressed; `readFile`,
`listDirectory`, `gitBase`, and `gitDiff` are absolutely addressed (ADR 14),
so their base travels in the request and they need no attachment. `gitShow`
alone remains attachment-bound: it reads the attached Session's Project cwd.
`pull` is Connection-local. `console` is accepted only when the daemon is in
dev mode and is a no-op acknowledgement.

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
model and thinking defaults, available model metadata, the daemon-global
`pinnedModels` list resolved from pi's global `enabledModels`, the
normal-tier `visibleModels` keys resolved from the bridge settings file,
supported thinking levels, and dev-mode state. Model defaults are resolved
from each Project's settings and the shared model runtime; they are display
data and do not pin a future `newSession` request when the client omits an
override. Pinned models is one daemon-global concept (ADR 15): a project-level
`.pi/settings.json` `enabledModels` override is not reflected, and the
`setModelPinned` verb writes the same global list (broadcasting
`pinned_models_changed`).

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
a Project route. The shell is served `Cache-Control: no-cache`; content-hashed
`assets/` entries are immutable. The same process owns the WebSocket server
used by Connections.

The web client turns these frames into URL-driven navigation and a Document
mirror; the overall layer relationship is described in
[architecture](../architecture.md).
