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

## Push frames

| `kind` | Payload and contract |
| --- | --- |
| `replace` | `{ session: SessionRef, document: Document }`. Always an initial sync. It replaces the mirror wholesale. |
| `patch` | `{ ops: PatchOp[], session?: SessionRef }`. A live patch has no `session`; a cursor-aware initial-sync patch has one. |
| `sessions_changed` | `{ projectId, sessions, hasMore, nextCursor? }`, the refreshed first page for one Project. |
| `active_sessions_changed` | `{ sessions }`, the global snapshot of active or streaming Sessions. |
| `pinned_models_changed` | `{ pinnedModels }`, the daemon-global pinned list after a pin or unpin (ADR 15). |

`replace` always carries a `SessionRef`. A `patch` carries a `SessionRef` only
when it is the initial-sync delta selected by cursor validation. A live patch
is attached to the already selected session and has no address. The initial
sync is emitted before later live patches on that Connection.

`SessionRef` is `{ projectId, sessionId, stem }`. `projectId` and `stem` are
the client address; `sessionId` is the durable cache and activation key. A
`SessionAddress` contains only the address pair. `SessionListCursor` is a
separate total-order cursor for Project history pagination and is not a
Document prefix cursor.

A push is unsolicited. `sessions_changed`, `active_sessions_changed` and
`pinned_models_changed` do not alter the Document mirror. The connection sends session-list pushes to every
socket; the web client updates the relevant Project page or global active
snapshot.

## RPC verb contracts

The following are the complete `RpcRequestBody` verbs. All successful replies
have `ok: true`; failures have `ok: false` and an `error` string. Effects on
the Document, when applicable, arrive as pushes before or independently of
the reply. A reply is therefore acknowledgement or query data, not a second
state channel.

| Verb | Address / binding | Successful reply and effects |
| --- | --- | --- |
| `prompt` | Attached Session | `{ ok: true }` after the prompt call is accepted/completed by the Manager; streaming and settle patches follow. Optional images are bounded by the host wire limits. |
| `abort` | Attached Session | `{ ok: true }` after abort and its finalization; final document patches precede the reply. |
| `discardSteer` | Attached Session | `{ ok: true }`; the queue-clear `status.pendingSteer` patch is the effect. |
| `setModel` | Attached Session | `{ ok: true }`; the Manager reconciles the model and any silent entry while idle. Invalid models fail. |
| `setModelPinned` | Daemon-global (ADR 15) | `{ ok: true }` after the global `enabledModels` scope is updated and flushed. The new resolved list follows as a `pinned_models_changed` push. |
| `setThinkingLevel` | Attached Session | `{ ok: true }`; status and any silent entry are reconciled. Invalid levels fail. |
| `renameSession` | Attached Session | `{ ok: true }`; the session name change and Project session-list refresh are pushed. |
| `navigate` | Attached Session | `{ ok: true }`; changes `status.leafId` and rebuilds the agent branch context. |
| `pull` | Attached Session and this Connection's subscription set | `{ ok: true, values: { entryId, fieldPath, value }[] }`. Provisional paths become live subscriptions; committed paths are one-shot. |
| `openSession` | Project plus `stem`; reattaches this Connection | `{ ok: true, session: SessionRef }`. The initial `replace` or cursor patch is pushed before the reply. An optional `PrefixCursor` selects the delta path. |
| `newSession` | Project; first prompt text is required | `{ ok: true, session: SessionRef }`. Model/thinking choices are applied and the first prompt is admitted before attach; initial sync carries the in-flight turn. Refused admission leaves no empty live Session. |
| `detach` | This Connection | `{ ok: true }`; releases the attachment and returns the client to Project-level navigation. |
| `closeSession` | Project plus `stem` | `{ ok: true }` after the live Activation is disposed. The session file survives; Project and active-session pushes refresh observers. |
| `archiveSession` | Project plus `stem` | `{ ok: true }` after the live Activation (if any) is disposed and the session file is moved under the reserved archive prefix. The file survives but is no longer discovered, and its stem is no longer addressable; Project and active-session pushes refresh observers. Fails when no durable file exists to move. |
| `listSessions` | Project plus optional `SessionListCursor` | `{ ok: true, sessions, hasMore, nextCursor? }`; a paginated history query, no Document push. |
| `listActiveSessions` | Daemon-global | `{ ok: true, sessions }`; no attachment and no Document push. |
| `getDaemonInfo` | Daemon-global | `{ ok: true, projects, models, pinnedModels, visibleModels, thinkingLevels, devMode }`; no attachment and no Document push. `pinnedModels` is the resolved daemon-global pinned list (not Document state, ADR 15); `visibleModels` is the resolved `provider/modelId` key list of the picker's normal tier. |
| `listFiles` | Project plus `prefix` | `{ ok: true, entries: { path, isDirectory }[] }`; paths resolve against the named Project cwd, so it works without an attachment. |
| `readFile` | Absolute path (ADR 14) | Content of one path at one snapshot state. `state` is a pinned 40/64-hex oid, `"head"`, `"index"` (the staged tree), or `"worktree"`; omitted means `"worktree"`. The reply is discriminated by `kind`: `"file"` (`{ state, path, content, truncated, bytes }`), `"absent"` (`{ state, path }` — a deleted file, a path not in a commit's tree, a directory, an unmerged index entry, or a path outside a repository for a snapshot state), or `"binary"` (`{ state, path, bytes }`, detected from a NUL byte). The path is absolute (`~`-rooted is the one other accepted form, expanded host-side because the client has no HOME); the host finds the containing repository and translates the path to a repository-relative one for `git cat-file blob <rev>:<path>` / `:<path>`. No attachment. |
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
namespace. `getDaemonInfo`, `listActiveSessions`, `listFiles`, and `console`
are not Session reads.

## Patch operations

`PatchOp` is JSON Patch's `add`, `remove`, `replace`, and `move`, plus the
bridge operation `append`:

```ts
{ op: "append", path: string, value: string }
```

`append` concatenates its string value to the string at `path`. It is used for
streamed text, thinking, and growing string leaves in partial tool arguments.
`move` is used to seal a provisional entry under its durable id. All operations
in one `Patch` are applied in order as one mirror transaction. JSON Pointer
paths use the standard `~1` and `~0` escaping.

The host filters lazy paths per Connection before sending a live patch. It
never changes the canonical document. An entry-root or content-block operation
is sanitized as well, so a parent value cannot smuggle an unsubscribed lazy
field to the client.

## Initial-sync addressing

The initial-sync contract is cursor-aware:

- A valid `PrefixCursor` produces one multi-operation `patch` with a `session`
  reference. It adds the missing committed suffix, current provisional
  skeletons, and full `status`.
- An absent or invalid cursor produces one `replace` with a `session` reference
  and the complete initial-sync projection.

The cursor is checked against the session file's ordered ids and the referenced
`sessionId`; it does not authenticate arbitrary client cache contents. Both
forms are address-bearing, so they establish the client's active cache key.
The initial-sync patch is never compacted, even when one of its operations
could otherwise look like a single append.

A Connection clears its lazy subscriptions when initial sync is sent and resets
its `CompactCodec` when it attaches. This prevents pull state and streaming
append state from crossing Session boundaries.

## CompactCodec

`CompactCodec` is stateful transport compaction at the WebSocket boundary. For
consecutive ordinary live `patch` frames containing exactly one string-valued
`append` to the same path, the first frame is sent in full to prime the path;
subsequent frames are sent as a bare JSON string containing only the appended
value. The decoder restores each bare string to a normal `patch` with an
`append` operation before the mirror sees it.

The remembered path is cleared by every other frame: multi-operation patches,
non-append operations including `move`, `replace`, broadcasts, and RPC replies.
A frame with `session` is never compacted because the compact form cannot carry
its `SessionRef`. `append` values are always strings, so a bare JSON string is
unambiguous. `reset()` is called on attach or reconnect. Reliable ordered
WebSocket delivery and the prime-first rule mean a compact frame cannot arrive
without a remembered path; the decoder treats that as a protocol violation.

The compaction is invisible above the transport. Core producers, the
`DocumentMirror`, and push listeners use the full typed frame shape.
