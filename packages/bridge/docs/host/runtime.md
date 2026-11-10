# Host Runtime

The host is the Node-side owner of live Sessions and the WebSocket protocol. A
Daemon owns the Connections, the browser attachment stream, delivery, and the
two daemon-global credential services (dictation, text polish). A Worker owns
the Projects, Session storage, Activations, pi runtimes, the model catalogue,
settings, and repository reads. An Activation contains one Manager and serves
exactly one Session for its entire lifetime. Activations are worker-internal;
the wire carries Session addresses and references, never an Activation.

The two halves run in one process by default and may run in two. The process
boundary is a deployment choice, not an architectural one: the Daemon reaches
the Worker only through `WorkerService`, and the in-process Worker and the
socket client implement the same contract. Nothing in the Daemon's routing,
attachment, or delivery code branches on locality.

## Worker service boundary

`src/host/worker-contract.ts` is the Daemon → Worker contract. It carries
values and opaque ids only: no `Connection`, `Manager`, `ActivationRecord`,
filesystem handle, or registry object crosses it, so a Worker could move
behind a socket without the Daemon branching on locality.

`WorkerEnvironment` is the part of the contract that owns state rather than
Sessions: `info()` (Projects, model catalogue, pinned and visible scopes,
thinking levels), `setPinnedModels`, and the repository surface (`listFiles`,
`readFile`, `listDirectory`, `gitShow`, `gitBase`, `gitDiff`). The Daemon keeps
no second model runtime and reads no Project file, because a remote Worker's
filesystem is not the Daemon's; it forwards these calls and serves the replies
verbatim.

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
metadata parse, live overlay), the session-location store
(`src/host/session-locations.ts`: the durable user-visible placement),
and the observation table. The Daemon holds no
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

## Startup Roles

An invocation takes one of three roles. **auto** (the default) joins a running
daemon as a Worker, or starts a daemon that hosts one Worker in this process.
**daemon** (`--mode=daemon`) serves the web app and registered Workers only and
never falls back to another role. **worker** (`--mode=worker`) registers this
invocation's Projects with an existing daemon and fails when none answers;
`--daemon <ws-url>` selects a remote daemon and implies the worker role.

Local discovery uses one address per user, independent of pi's agent directory:
`$HOME/.pi/bridge.sock`, or the named pipe `\\.\pipe\pi-bridge-<user>` on
Windows, where `node:net` will not bind a plain filesystem path (it reports the
rejection as `EACCES`). The user segment keeps the isolation `$HOME` provides
there, because the pipe namespace is machine-global. `windowsPipeName()` is the
one place an address is built from a name segment: every byte outside
`[0-9A-Za-z.-]` is escaped as `_xx`, because `new URL()` percent-encodes
non-ASCII (so `ws` would dial a path that does not exist) and splits the
`ws+unix:` path on the first `:` (so a name containing one is silently
truncated). Escaping expands each byte to three characters, so a name over the
256-character Windows limit is shortened and hashed instead of inheriting the
same bare `EACCES` an over-long bind reports; the spawned Worker's pipe comes
from the same helper. `--socket` overrides the default. The socket carries the
discovery probe and Worker registration only — never the browser surface — so a
local Worker needs no port guess and the web listener stays free to move.

```text
pi-bridge                     join a live daemon as a Worker, else start both
pi-bridge --mode=daemon       serve the web app and registered Workers only
pi-bridge --mode=worker       register this invocation's Projects, fail if no daemon
pi-bridge --daemon <ws-url>   register with a remote daemon (worker role)
```

A socket file proves nothing by itself. The default launch probes it with a
one-shot `ping` handshake and takes its role from the answer: a compatible
reply means join as a Worker, a missing path means start a Daemon, and a socket
file nothing listens on is removed before the Daemon binds. A listener that
fails the handshake — wrong protocol version, or not a bridge at all — is
reported instead of silently bypassed, and a path that is not a UNIX socket is
reported, never removed. The reply also carries the Daemon's browser base URL,
because it is the only daemon→launcher reply and a UNIX socket path has no
port to read; a Worker registers with an address it could not otherwise name.
A launch that loses the bind race joins the winner, which is the only case
where arrival order decides the role. Disposal removes the socket file, so the
next launch sees a missing path rather than a stale one. On Windows a pipe name
needs no cleanup step: the namespace entry disappears with the process that
bound it, so an interrupted run leaves nothing behind.

A forced `--mode=daemon` fails when the socket is already owned instead of
changing roles. A Worker's first registration must succeed; once registered, a
lost link is ridden out with bounded backoff — the Worker keeps its runtimes,
so an admitted turn survives a Daemon restart — and it re-registers with the
next Daemon. A registration the Daemon refuses (a Project id another
registration already serves, a reserved surface name) is terminal: the Daemon
closes the link with the rejected close code, and the Worker stops instead of
retrying a decision that cannot change. A refusal during Daemon shutdown is the
exception: that link closes gracefully, so a Worker that dials in mid-shutdown
retries the next Daemon rather than dying.

Startup output is one banner in every role: the version line, the role with the
socket it owns or dialed, the Project ids this process serves, and the alias
address a browser opens (ADR 13). A process serving exactly one Project links
that Project's alias, `/<project>/@latest`; anything else links the root form,
which spans Projects. Either resolves to the newest Session and falls back to
the scope's home (the Project home, or the launcher). A Worker cannot derive the
web port from its socket, so it takes the address from the probe; a remote
Worker derives it from its `--daemon` URL, whose single HTTP listener serves
pages and upgrades on one port. The banner is printed once per process; a
reconnect prints one line so a flapping daemon cannot repeat it. A combined
invocation says that it hosts the shared daemon in the foreground: exiting it
disconnects other Workers' browsers while those Worker processes keep running.

## Process title

Every process reports what it is doing in its own title, so a process listing
answers "which Worker, on what, doing what" without a browser
(`src/host/process-title.ts`):

```text
pi-bridge@acme: worker, idle              one Project, nothing running
pi-bridge@acme: worker, tool Bash         a tool executing
pi-bridge@acme: worker, stream            assistant text streaming
pi-bridge@acme,beta: daemon+worker, think  combined launch, this Worker thinking
pi-bridge@acme: worker, recover           idle with a recoverable broken tail
pi-bridge@acme: worker, offline           dialed-out Worker lost its Daemon
pi-bridge: daemon, wait                   no Worker registration yet
pi-bridge: daemon, serve 2                two Worker registrations routed
```

The title reads as an address: the Project names before the colon (how a
process is found), then role and phase after it. The phase is read from the
canonical Document's live Session set, so a Worker serving several Sessions
reports the furthest-along one; more than three Projects collapse the tail into
`+N`. The phase word comes from pi's event stream, but the Document is the
authority it is reconciled against: `isStreaming` and `status.inFlightTools`
outrank a decayed event word, so a run that settles while a tool it dispatched
is still executing keeps saying `tool`, and a streaming Session never claims to
be `idle`. The Daemon has no Projects to name and reports how many Worker
registrations it routes; in a combined launch the two halves compose into
`daemon+worker`. `--no-process-title` (or `PI_BRIDGE_PROCESS_TITLE=0`) keeps
the fixed `pi-bridge` title and reports no state.

Two mechanisms make this work, both native to Node. `process.title` rewrites
the argv memory in place, which is what `/proc/<pid>/cmdline` — the `htop`
Command column — and the 15-byte `comm` report. The writable width is exactly
the original command line's byte count, and a bundle launch (`./pi-bridge`) is
16 bytes, which cannot hold a role at all. So bootstrap re-execs through
`process.execve` with a padded argv0 and an injected `--title`, reserving 96
bytes: the same trick as postgres' `save_ps_display_args`, except `execve`
keeps the PID, so a Daemon's spawned-Worker handles survive it. The re-exec is
skipped when a debugger holds the inspector port, when `--title`/
`NODE_OPTIONS` already named the process (an explicit title wins, and is
therefore also how a deployment names a whole tree), and on Windows, where no
title mechanism exists at all. Titles are hints, not a contract: the arguments
are gone from the command line, so `pkill -f -- '--mode=daemon'` cannot match.

## Worker deployment

`src/host/worker-host.ts` is the only place a Daemon obtains a Worker. A Daemon
may register several, and the accepted registrations are its routing table: a
Project id is served by exactly one Worker, so `/<projectId>` is never
ambiguous. Registering a Project another Worker already serves fails the
startup — every Worker created so far is disposed, including the one whose
claim failed, so a spawned Worker cannot leak past a failed startup holding
its socket and its storage claims — and a Worker that becomes
unavailable withdraws only its own Projects; the others keep serving, and the
browser's queue is republished as the aggregate of the survivors.
The daemon report (`getDaemonInfo`) merges every registration's Projects,
catalogue, and pinned/visible scopes, deduped by identity.

Four modes share one host implementation:

- **dial-in** — the default for a second invocation: the Daemon binds the
  discovery socket (`--socket`; see [Startup Roles](#startup-roles) for the
  per-platform default) and a Worker connects to it, sending `hello` as its
  first frame. The Daemon never dials out for a local registration, which is
  what makes role discovery possible.
- **in-process** — the default of a combined launch, and what the test suites
  use: `startLocalWorker` builds the environment and the registry inside the
  Daemon process.
- **connect** — `connectWorker` dials a Worker that is already serving on a
  socket. Kept for embedders and tests that supply their own endpoint; it is
  not a CLI flag.
- **spawn** — the internal `--worker-spawn` deployment: the Daemon starts the
  Worker as a child process and connects to the socket it serves. The child runs
  this package's CLI with `--worker-serve`, so a single-binary install needs no
  second entry point; an embedding host with no CLI argv must use connect mode.

A Worker that dialed in owns its own lifetime: when its link closes (a Daemon
restart, a dropped socket), the Daemon drops the registration and the Worker
keeps its runtimes, reconnecting with bounded backoff. A Worker the Daemon
spawned is disposed with it. The internal `--worker-serve --socket <path>`
child role serves Projects, storage, runtimes, and the repository surface over
one socket with no browser protocol; signals dispose it, so a supervisor stops
it without leaving an exclusion claim behind.

A registration that arrives after startup joins the routing table under the
same all-or-nothing rule. The browser learns about it on its next
`getDaemonInfo` (a reload or reconnect): the surface has no project-list push,
so an already-open tab does not gain the new Projects live.

### Registration and Project claiming

The Worker's `hello` push is the handshake, and it is the only way a Daemon
learns what a Worker serves. It carries the `WorkerRegistration` and the
`WorkerInfo` (Projects, catalogue, pinned and visible scopes, thinking levels).

Acceptance is all-or-nothing: the Daemon rejects the registration and closes
the socket when a Project id is empty, duplicated, or collides with a reserved
surface name (a web asset root — the server would otherwise serve the asset
instead of the Project's page). A rejected registration routes nothing, which
is what makes `/<projectId>` unambiguous without a second protocol round trip.
The accepted set is the Daemon's routing table: a Project outside it answers
`Unknown project` even if some other Worker would serve it.

The protocol version is checked at the handshake. A peer speaking a different
version is refused rather than parsed, because a frame whose meaning changed
cannot be handled on a best-effort basis.

### Worker startup mode

`startLocalWorker` establishes pi-core's offline mode
(`PI_OFFLINE`/`PI_SKIP_VERSION_CHECK`) before it creates the model runtime or
loads extensions. The rule lives with the Worker, not the Daemon, because a
standalone `--worker-serve` process creates the runtimes: setting it in only
the Daemon would leave a separately started Worker silently online.

### Link liveness

An idle Session produces no traffic, so silence is not evidence of a dead peer.
Both ends ping on an interval and treat a link that has not ponged within its
deadline as lost — the same close path as a socket error. One direction covers
the Daemon's registration table; the other covers a Worker serving over TCP (a
remote `--daemon`), where a hung peer would otherwise pin its link with no
write ever failing. Without both, a half-open socket would pin a registration,
its Projects, and its observations until TCP noticed, which can take hours.

A lost link is not a crash. Pending requests reject, every observation ends — its
sink receives a terminal `closed` frame, so the browser's attachment ends
instead of waiting for content that cannot arrive — and `unavailable` listeners
fire once. The Daemon withdraws that registration, stops advertising its
Projects, and can reconnect as a new registration. The Worker keeps its
runtimes, because losing a Daemon is not a reason to kill an in-flight turn.

`unavailable` is terminal on both sides, not a hint. The Worker stops admitting
requests and ends the connection's observations when it reports one; the client
takes the same path as a socket failure, so a request admitted before the push
is settled rather than left waiting for a reply that cannot come.

### Storage exclusion

A registration ends with its socket while execution continues, so it cannot be
the exclusion primitive. Exclusion lives next to the filesystem: one lock file
per Session directory, held by the Worker for its lifetime (`src/host/storage-lock.ts`).

Two Workers writing one directory interleave JSONL appends, which no later
reconciliation can repair, so a Worker that cannot establish exclusion refuses
to serve rather than writing unsynchronized. The claim is an exclusively created
file (`wx`) holding the owner's pid, host, and a random token, released by the
holder only — a rewritten record belongs to a successor.

Reclaiming a crashed owner needs a delete, and a bare check-then-unlink is
unsafe: two reclaimers can both judge the same record stale, the winner can
create a fresh claim, and the loser's unlink removes *that* live claim. The
delete therefore runs inside a second exclusively created file
(`.pi-bridge.lock.reclaim`): only the guard holder may delete, the lock is
re-read under the guard and removed only if it is still the record that was
judged stale, and the guard is released in `finally`. A stale guard can only
block acquisition (availability), never permit a second holder (safety).
Reclamation is by liveness of the pid on the same host: a lock held by another
host is never reclaimed automatically, because a remote pid proves nothing
here.

**Limitation.** Kernel-released exclusion (an `flock`/`fcntl` lock, or one
SQLite transaction) would remove the pid probe and the guard; it needs a native
primitive this package does not depend on. A lock left by a crashed process on
another host therefore requires manual removal. The claim is still fail-closed,
which is the property that matters: no two Workers write one directory.

### Request admission and shutdown

The protocol server admits one request at a time and tracks every admitted
dispatch. `shutdown` stops admission synchronously, waits for the tracked
requests to settle, disposes the service, and only then replies — so a caller
that awaits the reply knows the Worker finished (runtimes disposed, exclusion
claims released) rather than agreed to stop; a spawned parent kills the child
on that reply, so it must not outrun the drain. The Worker's own disposal is
joinable: a second `dispose()` awaits the memoized drain, so the socket
shutdown and the process's signal handler cannot race an exit past it. A
request arriving after admission closed is dropped instead of starting work
nothing owns.

An observation acquired while a socket is closing is released by the acquisition
itself: the request registers a cancellable slot before it awaits, the close
marks it, and the completion releases what it produced instead of installing it
on a connection that no longer exists.

### Environment ownership

Model runtime, extensions, per-Project settings, the global `enabledModels`
scope, and the repository surface all belong to the Worker. The Daemon's
`getDaemonInfo` verb forwards `info()` and adds only its own `devMode`;
`setPinnedModels` is serialized inside the Worker that owns the scope, so
concurrent replacements cannot interleave. With several registrations the Daemon
forwards the replacement to every Worker and reports the deduped union of
their lists; that aggregate is only coherent while the registrations share
one settings file, so several Workers over distinct agent directories is not a
supported configuration — a partial write failure or divergent scopes would
leave the reports disagreeing, and giving the pinned scope one authoritative
owner across registrations is deferred until multi-Worker deployment is an
actual goal. `pinned_models_changed` reaches browsers as a Worker event, not a
Daemon poll.

Dictation credentials and text polish stay on the Daemon: the browser cannot
mint a SAMI token, register a device, or speak the polish protocol, and neither
service reads Project content. They are daemon-global credential services, not
Worker execution.

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

The Manager exposes one settlement signal. `onSettled` fires on `turn_end` and
`agent_settled` (the rescan trigger for the session list). It carries no
execution identity: a Session's place in the queue is not a settlement, so
nothing downstream needs to tell one execution's settle from another's. The
only execution-level bookkeeping is the location store's own admission token
(see "Session locations"), which never leaves the Worker.

The Manager API has these Session operations:

- `prompt(text, images?, model?, thinkingLevel?)` sends a user message and
  awaits the whole turn. This completion-style form is the internal call
  (tests, disposal-adjacent drains); the wire `prompt` verb uses the
  admission-style form below (ADR 12 Reply semantics). The optional carries
  are the stateless client API's selection and the worker-side adapter: while
  idle, a differing `model` is applied through pi's `setModel` (recorded as a
  `model_change`; pi re-derives the level for the switch) and a carried
  `thinkingLevel` is applied after it (clamped, recorded only on change);
  while streaming or compacting the carry is dropped so a queued steer keeps
  the running model. Carrying the in-force model is a no-op, so a client that
  always carries its inherited model adds no entries. The carry runs inside
  the turn's immediate admission, not on the serialized mutation line: a
  `navigate` committed by another Connection in between can therefore move the
  leaf the `model_change` lands on. `setModel`/`setThinkingLevel` remain on the
  Manager as the internal application path (the prompt carries and
  `newSession`'s pre-session choices are the callers); they are not wire verbs.
- `promptAdmitted(text, images?, model?, thinkingLevel?)` resolves at pi
  preflight admission and lets the turn continue in the background, so the
  reply's lifetime is bounded by admission rather than by the turn. It applies
  the same selection carries first (the reply then describes the selection the
  run uses). The daemon uses it for the wire `prompt` verb and for the first
  prompt of `newSession`; the tracked work it registers ends at admission, and
  the run stays live through the Document's streaming status.
- `executeBash(command, options?)` runs a user `!`/`!!` command in the Session
  cwd and records a `bashExecution` message. The host uses the persisted entry
  as the `user_bash_end` git-stamp boundary.
- `abort` clears queued steering text before waiting for pi to stop; it also
  aborts a running compaction (pi's `abort()` aborts the controller), which is
  what makes Stop the manual compaction's cancel.
- `discardSteer` clears queued steering text without aborting the run.
- `compact(customInstructions?)` runs pi's manual `/compact` path: it refuses
  while a turn streams (pi aborts first) or a compaction runs, appends the
  `CompactionEntry`, and recomputes `status.contextUsage` for it. pi answers
  "unknown" after a boundary (the last trusted usage predates it), so the host
  publishes the projection estimate — the same number as the run's
  `estimatedTokensAfter` — and the next settled response replaces it with
  measured usage. The verb reports pi's `tokensBefore`/`estimatedTokensAfter`,
  and the entry carries the summary request's usage for the ledger.
- `renameSession` and `navigate` update the
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

- **Mutations** (`compact`, `renameSession`, `setLabel`, `navigate`) are
  serialized among themselves — one at a time, in admission order — so
  concurrent commands from different Connections get a deterministic order.
  `compact` is the long one (a summary request): it holds the line for its
  duration, which is what keeps a navigate or a second compaction from
  interleaving with the boundary. It cannot deadlock behind streaming because
  it refuses while a turn is in flight (pi's manual compaction aborts the run
  first), and a Stop is immediate work, so cancellation never queues.
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
(ADR 19), and the wire carries transport compaction on the live path
(`core/compact-codec.ts`): a run of patches that differs only in the appended
string sends that string alone as a bare JSON string, and the client decodes
the identical envelope — generation included — so ownership on the wire is
preserved rather than skipped. Live patches are
already filtered when the Connection receives them: each observation filters
the Manager's stream against its own demand — the paths it pulled while the
entry was live — so a Connection never holds a subscription set and a second
observation of the same Session receives exactly what it asked for. A `pull`
reads through the attached observation and registers that demand.

Attachment changes mint the next **attachment generation** (ADR 19): every
observation frame the Connection emits — the initial sync, live patches, and
the terminal `session_closed` the Worker delivers when the observation's
registration ends — names the attachment whose stream it belongs to, and
a `pull` reply names the generation current when its request was admitted.
The client mirror admits a live frame only while it matches the established
generation, so a frame from an older attachment cannot touch the successor's
state even when the address is unchanged; the rule and the wire field are
specified in [core protocol](../core/protocol.md). The Connection keeps the
same rule server-side: a terminal frame always crosses the wire (the client
drops a stale one by its generation), but only the current attachment's
terminal frame ends the Connection's attachment — a close of the observation
a switch just left, whose release can race a concurrent `closeSession`, must
not detach the successor.

The Connection demultiplexes RPC frames by verb. Every verb that is not an
attachment transition is a typed handler in
`src/host/connection-verbs.ts`: a seam function that validates the request
shape, captures its target at handler entry (before any await), and replies
through a `VerbContext` exposing only the daemon seam, the attachment
target-bound commands, and the reply path — no socket, no transition state,
no runtime. Attached Session verbs are:
`prompt` (which carries the send's model selection — there is no separate
model verb), `abort`, `discardSteer`, `compact`,
`renameSession`, `setLabel`, `navigate`, and `recoverTurn`. They require an
attachment and are issued through the target-bound commands — the two
admission classes (immediate commands, serialized mutations) are the
Session actor's. Each handler captures the target at handler entry,
before any await, so a transition
that completes while the command runs cannot retarget it: the command
executes against, and reports on, the session attached when the request
arrived. The host validates prompt image envelopes and enforces the shared
image-count and image-size limits.

Navigation verbs are `openSession`, `newSession`, `detach`, `trashSession`,
and `setSessionLocation`. They route to the Daemon because they change
attachment, Activation, or listing state. The three that change this Connection's attachment —
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
`trashSession` and `setSessionLocation` change Activation or listing state, not
this Connection's attachment, and are not serialized against it. Query verbs are `listSessions`, `listQueue`,
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
completed), so every caller observes the same completion — `trashSession`
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

`trashSession` and an Archive move see the same address state an open does:
both first wait out a creation in flight for the address (`awaitSettled`),
because acting on the registered state alone could report "not active" — or
move the session file — while a Manager for that address is still being
constructed, and the completing creation would then register against an
address whose lifetime had already been decided.

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
resulting queue broadcast (a queued row's preview fields and `running` fact
refresh; its membership is the stored locations and never changes). Collection never deletes a
Session file.

`closeSession(projectId, stem)` is an explicit kill, not idle collection. It
normalizes and resolves the Project address and waits out a creation in flight
for it. With a live non-collecting Activation it immediately uses the same
collect/dispose path regardless of attached Connections, streaming state, or
idle policy. A dormant Session has no runtime to end, so the call is legal and
does nothing there; a stem with no session at all is an error. The placement is
untouched — a stop is not a move — and the verb is Worker-internal: the browser
reaches it through a location move. Collection is the terminal ownership
boundary: every Connection
attached to the address is detached — its Manager handle and attachment
fields are severed — and each receives a `session_closed` push
(`projectId`, `stem`) after the disposal's final patches and before the close
reply. A session command that arrives afterwards fails with `no session
attached` instead of reaching a disposed runtime, and a client rendering the
closed Session lands on its Project home. Idle collection never has an
attached Connection to notify, and daemon shutdown skips the frame (the
sockets are closing with the process).

`trashSession(projectId, stem)` ends a Session's runtime, then moves its file
under the reserved `.trash` prefix of the Project's session directory. It first
waits out a creation in flight for the address, then stops — using the same
collect/dispose path as `closeSession` when an Activation exists; a dormant
Session has none, so only the move happens. The move follows disposal because
disposal finalizes an in-flight turn, which can create or advance the file. A
trashed Session is neither discovered nor addressable: the scanner and the
startup `sessionId` conflict scan skip the prefix, and `normalizeStem` rejects
it. Its location record is dropped, so a session that is later moved back by
hand starts archived, as any unplaced Session does. The verb refreshes the
Project's first page; when it had an Activation, the terminal ownership
boundary detaches and notifies its Connections exactly as `closeSession` does.
A missing durable file (a fresh Session whose first turn never flushed) is an
error reply — the stop still happened, but nothing was moved.

The timer model and its reservation invariant govern this runtime.

## Session locations

`src/host/session-locations.ts` is the durable, user-visible placement of every
Session: **Inbox** (the attention list), **Later** (parked by decision), or
**Archive** (the default resting place — browsable history). Only the first two
are stored, at `<sessionDir>/.pi-bridge/locations.json` (one file per Project,
keyed by the session's stem — its address, so the record names the queue row it
needs with no index and no directory scan; the stem is stable for every
session the system serves, and the one case the durable session id would have
covered — a manual move to a different stem — loses the placement, by
decision). Archive is the absence of a record, which is why a Session nobody
placed costs no write.

Placement is independent of execution. Running is the runtime's own fact
(A.9), derived for a listing row from the live Document (§ Session listing), so
the store holds no execution state at all: a daemon restart has nothing to
recover, and the settle of an execution never writes a placement.

Each record also carries the instant of the transition that wrote it
(`placedAt`), because the queue's order is the placement's: a Session sits
where the last decision put it — a submission promoting it into Inbox, a user
move, a restored refusal — and the most recent placement leads its group.
Activity is deliberately not an input. A streaming turn advances the row's
`lastActivityAt` on every delta, so ordering by it would re-sort the queue while
the reader was reading it, and a row that merely ran would move above work the
user had queued ahead of it; busy is a temporal state. A move that lands where
the Session already was is not a transition and keeps its stamp, so a redundant
click cannot jump a row to the top.

The store owns two transitions. A submitted message (`promote`) places the
Session in Inbox under a fresh admission token, remembering the placement it
replaced; a refused preflight (`restore`) puts that placement back. The token
makes both sides safe against ordering: any later write — a newer admission or a
user move — replaces the record wholesale and drops the token, so a stale
restore is a no-op rather than an overwrite, and a move the user made mid-send
survives the refusal. A user move (`place`) is Inbox, Later, or Archive; a trash
(`prune`) drops the record. Moving to Archive is the store's write plus a
runtime stop (the verb collects first); moving to Trash is the stop plus the
file move.

A run an extension starts on its own (`context.prompt`, fire-and-forget) shows
`running` on the row like any other, because running is read from the live
Document rather than from an admission the bridge recorded. That is the same
declared gap as extension-initiated compaction in ADR 12: the bridge adds no
turn lifecycle of its own.

Writes are whole-file, atomic (temp + rename), and synchronous, so arrival
order is the serialization and no transition's decision can interleave with
another's. A missing file is the normal first state. A present but unreadable or
corrupt file is quarantined (renamed to a `.corrupt` sibling, never overwritten)
and surfaced on the console — the store restarts empty rather than silently
dropping queued work; only `ENOENT` counts as missing, so a permissions failure
or a directory in the file's place is quarantined like corrupt content instead
of silently serving an empty store that the next write would persist.
Admission writes (promote, restore) degrade to in-memory state and retry on the
next transition; user moves decide against a candidate copy, persist it, and
commit only on success — a failed move leaves the store exactly as it was, so a
retry re-attempts the write instead of reporting success against a placement
that was never durable.

The file is versioned. Version 3 is the stamped format; a version 2 file (the
place alone) is a known format rather than corruption, so it is upgraded in
place at load — its records share one empty stamp instead of a time invented
for them, which sorts them after every stamped placement until the user next
moves them, and a failed rewrite degrades to the upgraded store in memory
rather than quarantining a file whose content is intact. The pre-locations
format below recorded an instant of its own, so that one migrates into a real
stamp.

A pre-locations file (`states.json`, version 1, four states) is migrated on
load and removed: `notified` and `busy` become Inbox, `deferred` becomes Later,
`inactive` becomes absent (Archive). Startup then drops every record whose
session file does not exist (ADR 12's accepted loss, made visible: a first turn
that never flushed has no durable conversation, and a stem moved or deleted on
disk after the last write names no Session this Worker serves). The check is one
containment-checked existence probe per record — the queue's size, not the
history's — and a store-file key that is not a canonical stem, or a value that is
not a stored place, is a bad record, quarantined with the rest: the file is disk
input, and no key may name a path the queue could resolve outside the Project's
session directory.

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

### `trashSession`

`trashSession` takes a Project id and a normalized stem. It looks up the
address's Activation and collects it when one exists — a stop, not a GC, so
streaming state and attached Connections do not defer it, and disposal
finalizes the turn so the file cannot advance after the move. It then moves
`<sessionDir>/<stem>.jsonl` to `<sessionDir>/.trash/<stem>.jsonl`, creating the
trash directory tree. Both the source and the destination directory are
containment-checked, so a symlinked `.trash` cannot redirect the move outside
the Project namespace. The move refuses to overwrite an existing trashed file.
The Session file survives; it merely leaves discovery, and moving it back is a
manual filesystem operation. A `.archive/` directory left by the pre-rename
layout is folded into `.trash/` at Worker start (reported and left alone when
both exist, so no tree is merged blindly).

### `setSessionLocation`

`setSessionLocation` takes a Project id, a normalized stem, and `inbox`,
`later`, or `archive`. Inbox and Later are storage writes: legal on a dormant
Session (no runtime is needed) and on a running one (a move never pretends the
execution ended). Archive collects the address's Activation first when one
exists — archived history is not being worked on — and then writes the
placement; its attached Connections are detached and notified exactly as
`trashSession` does. A stem with no Session at all is an error. The result
reaches every browser in the next queue delta (see "Queue publication"),
together with the Project's history invalidation.

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
`timestamp`, the durable user-visible `location` (`archive` by default — the
only classification a row carries; runtime retention is execution detail that
stays in the Document), and available name, first-message text,
latest-message preview, message count, and last-activity time. A durable file
supplies metadata; an unflushed active Session supplies the actor's
`metadata()` — the typed read surface over the canonical Document. For
an active row the live latest-message preview and last-activity time win over
the file scan; `timestamp` remains the durable sort key (mtime / header
creation).

A row for a running Session carries the execution's `activity` (ADR 23), and
its presence *is* the row's running fact — there is no second flag. The actor's
`metadata()` derives it from the reconciled phase word — a running tool with
the instant its phase began, `responding` for a streaming run without a tool,
`compacting` for compaction — and omits it when the runtime is idle. Parallel tool calls share the phase, so the name is the most
recently started tool still running: one sibling ending does not erase the
other's name or restart the phase clock. The actor records the phase-change
instant from the Manager's deduped `onActivityChange` — deduped *and*
phase-scoped, so a text delta does not change the phase, a name change inside
one phase does not restart the clock, and a phase change updates the row the
Worker keeps materialized.

`listQueue` is the global queue: every Inbox and Later Session across every
Project — membership is the location store's key set, in memory, not the
registry and not a directory scan, so a dormant Inbox Session is a queue row
with no runtime and a browsed archived Session is not a row at all. The Worker
keeps that slice **materialized** (ADR 24): a metadata-only trigger rebuilds
live rows from the registry's `metadata()` and reuses the stored dormant rows,
so an activity or streaming callback reads no Session file; registration,
placement, Trash, close, rename, and the `listQueue` query itself rebuild in
full, which is also how an external filesystem edit is discovered. A stored
record whose stem resolves to no file and no Activation — moved or deleted on
disk after the record was written — renders no row, and the next boot's
recovery prunes it. The slice is ordered Inbox → Later, each group by placement
stamp descending (most recently placed first), and its total order lives in one
browser-safe comparator (`src/core/queue-order.ts`) shared by the Worker that
orders its slice, the Daemon that aggregates the slices, and the browser that
orders the rows it receives, so a multi-Worker queue interleaves by the same
rule instead of concatenating per-registration blocks.

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
`setPinnedModels` verb writes the same global list (broadcasting
`pinned_models_changed`). The verb carries the whole ordered list, so its
mutations are serialized inside the Worker that owns the scope — one at a time,
in arrival order — and the worker rewrites the scope in that order, dropping
entries the runtime cannot resolve, deduping by identity (first position wins),
and carrying each entry's `:level` suffix verbatim so a reorder never changes
what a pin means. An empty list clears the scope, which is the "no pins" state
a fresh Session resolves through pi instead. Accepted window: because the
request is the list the client last saw, two clients replacing concurrently are
last-writer-wins — a backgrounded tab can revert a pin it never received. The
window is one push wide for a connected client (pushes and requests ride the
same socket) and is documented rather than closed; a revision echo on the
request would close it if it ever matters.

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

### Queue publication

The queue is the one synchronized listing (ADR 24). The Worker reports
*changes*: a `queue_changed` event carries the registration-local `version` its
slice moved to, the complete changed rows, the addresses that left, and the
`origin` the Daemon publishes at (`user` for a gesture a person made, `runtime`
for execution state). Rows
are diffed against the slice the Worker keeps materialized, so several
callbacks observing one transition — and repeated callbacks observing none —
emit nothing. `history_changed` names a Project whose cached history a trigger
touched (settlement, rename, creation, Trash, placement); it carries no rows.
`session_completed` reports one settled execution in a queued Session. The
Manager reports both settle boundaries it observes — pi's `turn_end`, which
falls after every assistant step, and `agent_settled`, which ends the run —
because metadata refreshes need both; the completion rides only the execution
boundary. A user-requested end (Stop, Archive, Trash, explicit close)
finalizes a turn without announcing a completion.

The Daemon owns aggregation and the rate:

- A registration's slice is seeded from `listQueue`, which answers with the
  same materialized slice its deltas advance plus that slice's `version`, so a
  seed that resolves late cannot roll back a delta that already landed.
- The Daemon merges the slices with the shared comparator, diffs the aggregate
  against the **published** queue, and broadcasts one `queue_changed` delta at
  most once per `QUEUE_PUBLISH_INTERVAL_MS` (five seconds; a test seam on
  `DaemonOptions`) for **execution state**. One timer for the whole Daemon
  bounds the rate no matter how many Workers or Sessions changed, and a change
  during the cooldown never extends the deadline. A change the Worker tags
  `origin: "user"` — a placement, a Trash, an admitted message — publishes at
  a 150 ms floor instead, because the row that person just moved must move on
  screen; `due` only ever moves earlier, so a runtime change cannot delay a
  gesture and a gesture cannot stretch the interval for execution state. An
  empty diff with no pending history invalidation publishes nothing. The
  revision increments exactly once per nonempty publication.
- Each Connection's first queue frame is a `snapshot` of the last published
  queue, pushed synchronously when the socket is accepted. Capturing it,
  enqueueing it, and adding the Connection to the broadcast set are one step,
  so no publication can land between the baseline and the stream; pending
  changes arrive at the next deadline. Replacing a Connection starts a new
  revision domain.
- `session_completed` is forwarded immediately, bypassing the interval: a
  sample would hide a turn shorter than five seconds. `archive`, `trash`,
  explicit close, and Stop dispose or abort a runtime, and that finalizes the
  in-flight turn; the resulting settlement is suppressed for the address being
  ended, because the user asked for it and is not waiting for a completion.
  Suppression is released whether the operation succeeds or fails. Worker
  withdrawal removes its rows at the next publication and announces no
  completions.

Connections receive these frames regardless of which Project they currently
have attached. The worker side of the same triggers is described under
"Session listing".

### Assets

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
