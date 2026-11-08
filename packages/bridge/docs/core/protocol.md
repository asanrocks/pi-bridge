# Wire Protocol

The protocol is the contract between `host` and `web`. It is defined in the
browser-safe core types, not inferred independently by either endpoint. The
data carried by the protocol is the immutable `Document` described in
[data-model.md](data-model.md); incremental attach and cache behavior are in
[sync.md](sync.md).

## Two channels on one WebSocket

Every client-to-server frame is an `RpcRequest` with an opaque `id` and a
string `verb`. Every server reply carries the same `id`, `ok`, and, on failure,
`error`. A reply may carry verb-specific result fields, but never carries
Document state. Document state is delivered only by server push.

A server push has no `id`. The connection demultiplexes by the presence of
`id`: an id is RPC reply traffic, and no id is push traffic. The client
`BridgeClient` applies `replace` and `patch` pushes to its `DocumentMirror`,
while exposing all pushes to the web store.

Correlation precedes transmission: the client installs an RPC's pending record
before the request leaves, because a transport may deliver a reply inside
`send` (an in-process link) or fail synchronously (a closed socket). A reply
with no pending record is dropped, and a throwing `send` removes the record
and rejects exactly once, so a failed request leaves nothing pending.

## Push frames

| `kind` | Payload and contract |
| --- | --- |
| `replace` | `{ session: SessionRef, document: Document, generation, operationId? }`. Always an initial sync. It replaces the mirror wholesale. `operationId` is present only when the frame was emitted by a `newSession` transition: the operation id of that creation. |
| `patch` | `{ ops: PatchOp[], session?: SessionRef, generation, operationId? }`. A live patch has no `session`; a cursor-aware initial-sync patch has one. `operationId` is present only on a creation's initial-sync patch. |
| `sessions_changed` | `{ projectId, sessions, hasMore, nextCursor? }`, the refreshed first page for one Project. |
| `queue_changed` | `{ sessions }`, the global queue: every Inbox and Later Session, ordered Inbox → Later, each group by last activity descending. Membership is the stored location, never runtime retention. |
| `pinned_models_changed` | `{ pinnedModels }`, the daemon-global pinned list after a pin or unpin (ADR 15). |
| `session_closed` | `{ projectId, stem, generation }`. The live runtime behind that address ended (the Session was moved to Archive or Trash). Every Connection attached to it is detached before the frame is sent, so a session command that arrives afterwards fails with `no session attached`; a client rendering that Session lands on its Project home. |

`replace` always carries a `SessionRef`. A `patch` carries a `SessionRef` only
when it is the initial-sync delta selected by cursor validation. A live patch
is attached to the already selected session and has no address. The initial
sync is emitted before later live patches on that Connection.

A creation's initial sync carries the `newSession` request's `operationId`:
the Connection stamps it onto the frame it emits inside the transition (the
attach is synchronous within it), and onto the reply. The id names the
*operation*, not the resulting Session — the address does not exist until the
server allocates the file — so a client's selection owner can admit the frame
only while the intent that sent the request still owns the view. Frames
without an `operationId` (opens, re-attaches, reconnects) select nothing on
their own: the client admits them only as re-assertions of the rendered
address or through an in-flight transition it owns.

`SessionRef` is `{ projectId, sessionId, stem }`. `projectId` and `stem` are
the client address; `sessionId` is the durable cache and activation key. A
`SessionAddress` contains only the address pair. `SessionListCursor` is a
separate total-order cursor for Project history pagination and is not a
Document prefix cursor.

**Attachment generations (ADR 19).** Every observation frame — a replace, a
patch (live or initial sync), a `session_closed`, and a `pull` reply —
carries a required `generation`: the attachment that produced it, one mint
per attach on its Connection. Ownership on the wire is not optional: a
frame without a generation is a protocol violation and is dropped. An
address-bearing frame (a replace, a cursor-aware initial-sync patch)
establishes the client mirror's generation; a live frame that does not
match the established one is dropped before the mirror — same address or
not, a frame from an older attachment cannot touch the successor's state,
and a mirror with no established generation holds no observation and admits
no live frame. A `pull` reply carries the generation current when its
request was admitted, so a reply that lands after a reattach is dropped
instead of filling the successor with the old observation's values.

A push is unsolicited. `sessions_changed`, `queue_changed`,
`pinned_models_changed`, and `session_closed` do not alter the Document
mirror. Every listing row (`sessions_changed`, `queue_changed`,
`listSessions`, `listQueue`) carries the Session's durable `location`
(`inbox | later | archive`, `archive` by default) and never an execution
fact — streaming is Document state, not a listing field.

A row also carries an optional `activity` — the execution's own report, on a
running row only: `{ kind: "tool", name, startedAt }`, `{ kind: "responding" }`,
or `{ kind: "compacting" }`. `startedAt` is the instant the current phase
began, computed at emission, so the client rebases the elapsed time onto its
own clock exactly as it does for `status.inFlightTools`. Its presence *is* the
row's running fact: the field is absent on a dormant row (no runtime, nothing
executing), so absence is the truthful answer rather than stale state, and no
second boolean repeats it. `location` remains the authority for where the
Session belongs. The connection sends session-list pushes to every
socket; the web client updates the relevant Project page or the queue,
and a `session_closed` for the rendered Session ends that view
without touching the mirror.

## RPC verb contracts

The following are the complete `RpcRequestBody` verbs. All successful replies
have `ok: true`; failures have `ok: false` and an `error` string. Effects on
the Document, when applicable, arrive as pushes before or independently of
the reply. A reply is therefore acknowledgement or query data, not a second
state channel.

Every attached-session verb captures the Session target it addresses at
handler entry, before any await: a transition that completes while the
command runs cannot retarget it, so the command executes against — and its
reply reports on — the session that was attached when the request arrived,
even if a switch has since moved the Connection elsewhere. Mutations
(`renameSession`, `setLabel`, `navigate`)
enter the session's serialized mutation line; turns, aborts, and reads run
immediately but tracked (see [host runtime](../host/runtime.md)).

| Verb | Address / binding | Successful reply and effects |
| --- | --- | --- |
| `prompt` | Attached Session | `{ ok: true }` once pi's preflight admitted the prompt — the message is queued or the turn started, and streaming and settle patches follow. The reply never waits for the turn (ADR 12 Reply semantics), so a client is free to disconnect while the turn runs. Optional images are bounded by the host wire limits. Optional `model` and `thinkingLevel` carries are the stateless client API's selection: applied to pi's session before the turn (a differing model is recorded as a `model_change`; pi re-derives the level for a model switch unless a level is carried, and clamps a carried level to the model's supported levels). Applied only while idle — a queued steer keeps the running model. An omitted carry leaves the session's current selection (the last applied one) in force; that selection is also what unattended runs (recovery, compaction) use. A malformed `model`, and a `thinkingLevel` naming a level outside the set `getDaemonInfo` reports, are refused before anything is applied; an unknown model fails the prompt. |
| `abort` | Attached Session | `{ ok: true }` after abort and its finalization; final document patches precede the reply. |
| `discardSteer` | Attached Session | `{ ok: true }`; the queue-clear `status.pendingSteer` patch is the effect. |
| `setPinnedModels` | Daemon-global (ADR 20) | `{ ok: true }` after the global `enabledModels` scope is replaced with the request's ordered list and flushed. The reply is acknowledgement only: the *resulting* resolved list follows as a `pinned_models_changed` push, because the host filters entries the catalogue cannot resolve and keeps the first occurrence of a duplicate identity — a replacement is a proposal, the push is the verdict. Position is meaning (the head is a fresh Session's default model, the order is the cycle order) and an entry's thinking level round-trips verbatim. A malformed entry, a level outside the set `getDaemonInfo` reports, or more than the wire cap is refused before the scope is touched. |
| `renameSession` | Attached Session | `{ ok: true }`; the session name change and Project session-list refresh are pushed. |
| `navigate` | Attached Session | `{ ok: true }`; changes `status.leafId` and rebuilds the agent branch context. |
| `pull` | Attached Session and its observation's demand | `{ ok: true, values: { entryId, fieldPath, value }[] }`. Provisional paths become the observation's live demand; committed paths are one-shot. |
| `openSession` | Project plus `stem`; reattaches this Connection | `{ ok: true, session: SessionRef }`. The initial `replace` or cursor patch is pushed before the reply. An optional `PrefixCursor` selects the delta path. |
| `newSession` | Project; first prompt text and an `operationId` are required | `{ ok: true, session: SessionRef, operationId }`. Model/thinking choices are applied and the first prompt is admitted before attach (a `model` pick without a level resolves one as a fresh session on that model — see `ProjectInfo.defaultThinkingLevel`); initial sync carries the in-flight turn and the operation id. Refused admission leaves no empty live Session. A missing `operationId` is refused — an unattributed creation cannot be admitted by a selection owner. |
| `detach` | This Connection | `{ ok: true }`; releases the attachment and returns the client to Project-level navigation. |
| `trashSession` | Project plus `stem` | `{ ok: true }` after the live Activation (if any) is disposed and the session file is moved under the reserved trash prefix; the session's location record is dropped. The file survives but is no longer discovered, and its stem is no longer addressable; Project and queue pushes refresh observers. Attached Connections are detached and receive a `session_closed` push. Fails when no durable file exists to move. |
| `listSessions` | Project plus optional `SessionListCursor` | `{ ok: true, sessions, hasMore, nextCursor? }`; a paginated history query, no Document push. |
| `listQueue` | Daemon-global | `{ ok: true, sessions }`; the queue: Inbox and Later Sessions, ordered Inbox → Later, then last activity descending. No attachment and no Document push. |
| `setSessionLocation` | Project plus `stem` and a `location` of `inbox`, `later`, or `archive` | `{ ok: true }` after the placement is durable. Inbox and Later never touch execution; Archive also ends the runtime, so its attached Connections are detached and receive a `session_closed` push as with `trashSession`. Legal on a dormant Session; a stem with no session at all is an error. The change arrives as a `queue_changed` push. |
| `getDaemonInfo` | Daemon-global | `{ ok: true, projects, models, pinnedModels, visibleModels, thinkingLevels, devMode }`; no attachment and no Document push. `pinnedModels` is the resolved daemon-global pinned list (not Document state, ADR 15); `visibleModels` is the resolved `provider/modelId` key list of the picker's normal tier. |
| `asrCredentials` | Daemon-global | `{ ok: true, auth }` where `auth` is `{ kind: "device", deviceId }` or `{ kind: "token", token, expiresAt }`. The daemon mints or registers it because a page can neither mint a SAMI token nor register a device; a secret access key never crosses the wire. No attachment, no Document push: the ASR session itself runs from the browser to the endpoint. Failure is an ordinary `ok: false` and is retried on the next request. |
| `textPolish` | Daemon-global | `{ ok: true, text }` after the daemon rewrote the request's whole `text` through the upstream polish service. Only the draft crosses this socket: the protocol's keys and signatures were never the page's. The reply is the text to show instead, which equals the request's text when there was nothing to arrange. A failure is an ordinary `ok: false` whose `error` is written for the composer's row (unavailable, too long, timed out). Requests are serialized daemon-side. No attachment, no Document push. |
| `listFiles` | Project plus `prefix` | `{ ok: true, entries: { path, isDirectory }[] }`; paths resolve against the named Project cwd, so it works without an attachment. || `readFile` | Absolute path (ADR 14) | Content of one path at one snapshot state. `state` is a pinned 40/64-hex oid, `"head"`, `"index"` (the staged tree), or `"worktree"`; omitted means `"worktree"`. The reply is discriminated by `kind`: `"file"` (`{ state, path, content, truncated, bytes }`), `"absent"` (`{ state, path }` — a deleted file, a path not in a commit's tree, a directory, an unmerged index entry, or a path outside a repository for a snapshot state), or `"binary"` (`{ state, path, bytes }`, detected from a NUL byte). The path is absolute (`~`-rooted is the one other accepted form, expanded host-side because the client has no HOME); the host finds the containing repository and translates the path to a repository-relative one for `git cat-file blob <rev>:<path>` / `:<path>`. No attachment. |
| `listDirectory` | Absolute path (ADR 14) | One directory's immediate children at one snapshot state: `{ ok: true, path, state, entries: { name, path, isDirectory }[], omitted, absent }`. A missing directory — or a snapshot state for a path outside a repository — is `absent`, not an error. Listing is lazy (one directory per call, never a recursive scan); `.git` is never listed; `omitted` reports entries the host cap left out. No attachment. |
| `gitShow` | Attached Session | `{ ok: true, output, truncated }`; the validated commit is read from the attached Project cwd. |
| `gitBase` | Absolute directory (ADR 14) | The comparison base for reviewing one commit: `{ ok: true, baseline }`, its first parent's oid or — for a root commit — the repository's empty-tree oid (resolved with `git hash-object -t tree --stdin`, never a hardcoded constant). The result is a diff state for `gitDiff`, not a picker value. No attachment. |
| `gitDiff` | Absolute directory (ADR 14) | The diff *directive* between two states (a pinned 40/64-hex oid, `"head"`, `"index"`, or `"worktree"` — `"worktree"` only as `new`) under an absolute directory: `{ ok: true, files, filesOmitted?, untrackedOmitted? }`. `files` carries path, rename source, `status` (from git's raw directive), ±counts, binary, and `untracked`; paths are relative to `directory`, which also scopes the result to that subtree. A worktree-side diff also lists untracked, non-ignored files (without counts, since git's own diff omits them); `filesOmitted` and `untrackedOmitted` report what the host caps left out. No patch text crosses the wire: the renderer fetches each file's content with `readFile` and diffs it client-side. No attachment. |
| `console` | Daemon dev mode | `{ ok: true }`; forwards browser console data only when development mode is enabled. It does not change the Document. |

The attachment-bound verbs reject with `ok: false` when no Session is attached.
`readFile`, `listDirectory`, `gitBase`, and `gitDiff` are not among them: they carry
absolute paths (ADR 14), so they need no Session to resolve a base, and a
Connection that never opened one can still browse the filesystem and the
repository. Project-addressed verbs validate their `projectId` and, where
applicable, normalize and resolve the `stem` within that Project's session
namespace. `getDaemonInfo`, `listQueue`, `listFiles`, `asrCredentials`,
`textPolish`, and `console` are not Session reads.

## Patch operations

`PatchOp` is JSON Patch's `add`, `remove`, `replace`, and `move`, plus the
bridge operation `append`:

```ts
{ op: "append", path: string, value: string }
```

`append` concatenates its string value to the string at `path`. It is used for
streamed text, thinking, and growing string leaves in partial tool arguments.
An append may carry `lazy: true`: it targets a lazy field (a streamed tool
body), and the host withholds it from an observation whose demand does not
cover the op's path or an ancestor — exactly like the full-field replace it
encodes. `move` relocates a value; sealing does not use it, because an entry's
id is stable from its first event. All operations in one `Patch` are applied
in order as one mirror transaction. JSON Pointer
paths use the standard `~1` and `~0` escaping.

The host filters lazy paths per observation before a live patch leaves the
Worker. It never changes the canonical document. An entry-root or content-block operation
is sanitized as well, so a parent value cannot smuggle an unsubscribed lazy
field to the client.

## Initial-sync addressing

The initial-sync contract is cursor-aware:

- A valid `PrefixCursor` produces one multi-operation `patch` with a `session`
  reference. It adds the missing persisted suffix, current live forms, and full
  `status`.
- An absent or invalid cursor produces one `replace` with a `session` reference
  and the complete initial-sync projection.

The cursor is checked against the session file's ordered ids and the referenced
`sessionId`; it does not authenticate arbitrary client cache contents. Both
forms are address-bearing, so they establish the client's active cache key.
An observation clears its demand when initial sync is sent. This prevents pull
state from crossing Session boundaries.

## Transport compaction

A streamed turn is a run of live patches that differ in exactly one thing:
the appended string. The first frame of a run travels in full form; every
following frame that differs from it in exactly the appended value travels
as that value alone — a bare JSON string (`core/compact-codec.ts`).

The compaction is envelope-preserving. The codec holds the last full-form
compactable frame as a template and compacts only against it, and the
template carries every field of the frame — the attachment generation
included — so a frame after an attachment change can never match the stale
template: compaction across an attachment change is structurally
unrepresentable, and the decoded frame is the identical object the full
encoder would have sent. Ownership on the wire (ADR 19) applies to the
decoded frame unchanged. Any other difference — a different path, a
different op, a multi-op patch, a replace, a broadcast, an RPC reply —
fails the match and travels in full form, and a non-compactable frame
never touches the template, so an interleave cannot desync the pair.
Compaction requires message-ordered delivery (WebSocket ordering); a
transport without it must not enable it.

A message the client cannot decode or does not recognize — malformed JSON,
a bare string with no established run, or a frame shape outside the
protocol (an unknown push kind) — is never silently tolerated: the client
surfaces it (`BridgeClientOptions.onProtocolError`), and the web client
toasts and closes the socket, so the reconnect path's initial sync
repairs the stream. The daemon and the app ship together, so a repeated
violation is version skew and the toast names reloading the page as the
fix. The wire carries no version negotiation by design; the one cost is
the upgrade window: a tab left open across a daemon upgrade speaks the
previous dialect, and its transcript may stall mid-stream until the page
is reloaded.
