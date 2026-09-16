# pi-bridge

An alternative protocol for AI coding agent sessions. Monitor, steer, and explore agent work from a browser or CLI, without staring at the terminal. pi-bridge starts a pi instance and serves a daemon on localhost; a colleague opens a browser and sees the same conversation — streaming text, foldable thinking, tool call cards — without installing anything or sharing a terminal.

The browser is the primary UI. The protocol itself is UI-neutral and also has first-class CLI support.

## Debugging

Pass `--log <path>` to capture all WebSocket frames as JSONL. Each line is `{ ts, d: "in"|"out", frame }` — the raw JSON objects that crossed the wire. Add `--dev` to also relay browser `console.*` calls to the server as `console` RPC frames; the browser hooks `console.log`/`warn`/`error` automatically when the server reports `devMode: true`.

## Status

Document model (ADR 02), component model (ADR 06), client architecture (ADR 07), immutable Document, read-tracked lazy pulls, and the project/session daemon model (ADR 11) implemented. `core`, `viewmodel`, `host`, and `web` are wired. All tests passing. The client navigates by URL (`/launcher`, `/chat/<projectId>`, `/chat/<projectId>/<stem>`); the daemon owns Project configuration and internal, idle-collected activations; the launcher surfaces active sessions across Projects. Connection-state machine + down-state panels remain.

- `docs/architecture.md` — the high-level overview: problem, central insight, layers, data model, sync model, state machine, invariants, test design. Read this first.
- `docs/02-data-model.md` — ADR 02: Document, entries, patches, lazy content, wire protocol (reconcile/seal, provisional naming, delta-driven streaming).
- `docs/04-prd-web-ui.md` — PRD for the web UI: verbs, sidebar, composer, history, pickers.
- `docs/06-component-model.md` — ADR 06: Manager, Connection, Daemon, dual-channel wire protocol, `BridgeClient`. Its instance-centric routing verbs, push table, and `instance_exit` addendum are superseded by ADR 11; the Manager/Connection seams remain.
- `docs/07-adr-client-architecture.md` — ADR 07: React client architecture (store, ViewModel, components, wants-outbox pull, reconnect).
- `docs/08-adr-object-kernel.md` — ADR 08 (Proposed): object kernel — daemon as IPC directory/router, peer objects (instances, clients, meta), symmetric envelope, per-facet sync (log/state/transient). Successor candidate for the ADR 06 component model.
- `docs/09-adr-incremental-sync.md` — ADR 09: incremental sync — client-side IndexedDB cache + attach-time cursor (`lastKnownId` + `entryCount`), server-assigned `ord`, delta-as-patch push with full-`replace` fallback, cache-is-untrusted principle. Extends ADR 06; carried over into ADR 08's Log facet if the object kernel lands.
- `docs/10-adr-git-stamp.md` — ADR 10: git identity stamps — bridge-bundled extension records HEAD commit/branch/subject transitions as `custom` entries at prompt/tool_end/turn_end/user_bash_end boundaries; shared payload in `core` (v1+v2), identity fold + ordered `GitChange` items in `viewmodel`, chip + change cards in web.
- `docs/11-adr-projects.md` — ADR 11 (Accepted; activation-lifecycle sections amended by ADR 12, Proposed): projects and sessions — the client-facing domain is `Project` + `Session` only; `Project` is static daemon configuration (id = validated last path segment, unique, startup-rejected on duplicate ids and session-storage collisions); a session is addressed by `(projectId, stem)`, where `stem` is its jsonl path under the Project's session directory minus `.jsonl`, allocated at creation (before the first flush), while `sessionId` stays the durable cache key; "active" is session metadata backed by an internal, never-on-the-wire activation (one per session, GC'd when idle); `openSession` resolves-or-creates an activation and activations are never rebound to another session; URLs (`/launcher`, `/chat/$proj`, `/chat/$proj/$stem`) are consequences of the model.
- `docs/12-adr-activation-lifetime.md` — ADR 12 (Proposed, not implemented): activation lifetime and the connection state machine — amends ADR 11 by replacing idle GC with the refcount rule `connectionCount > 0 || isStreaming || isCompacting` enforced at two event boundaries (refcount→0, settle-with-zero-clients) plus an admitted-work window (a prompt admitted but not yet observable in the Document counts as in-flight; no timers, no filesystem in lifetime); gives `openSession` transactional switch semantics valid in both detached and attached states (a failed switch rolls back with no switch-generated push to any client — activations are staged, their broadcasts deferred until commit, and staged disposal is silent; concurrent unrelated broadcasts still flow); defines per-verb reply semantics (admission-style `prompt` resolving at pi's `preflightResult`, never holding the per-Connection lane for a turn); projects three user-facing states (streaming / idle / inactive — attachment is not wire info); makes empty sessions client-side floating drafts (`newSession` requires `text`, admits the prompt before attaching, so unflushed activations exist only for the first-turn window; `listFiles` is re-addressed to the Project for pre-send completion); fixes the dead-connection attach pin and the reservation-ownership interval. Warmth/reuse-by-rebind explicitly deferred, gated on a cold-open latency measurement. Until implemented, ADR 11 describes the shipped behavior.

## Implementer rules

Architectural invariants live in `docs/architecture.md` §7. The rules below are specific to this codebase — follow them or the build breaks.

- **One package.** Lockstep versioning (root `AGENTS.md`) removes the only real argument for splitting. One package keeps one tsconfig/build and one `tsgo --noEmit`.
- **`core` is pure — browser-smoke gate.** No `fs`, `net`, DOM, or terminal. Browser-safety is enforced by the repo-root `scripts/check-browser-smoke.mjs`: the gate is a curated import list in the repo-root `scripts/browser-smoke-entry.ts` (imports the full browser-safe surface from `@earendil-works/pi-bridge`: `BridgeClient`, `DocumentMirror`, `planPull`, the `core` pure functions, and the `viewmodel` functions), not an automatic per-package scan. The smoke check esbuild-bundles that entry for `platform: "browser"` and fails transitively on any reachable `node:*`. It resolves the package export to `dist/`, so rebuild (`npm run build`) after adding exports. When adding new browser-safe modules (in `core/` or `viewmodel/`), export them from `src/index.ts` and add a usage line to the entry so tree-shaking doesn't elide them.
- **`./node`/`./cli` staying node-only is convention**, not enforced by the smoke gate.
- **`web/` reaches into `src/` by design.** The web app imports directly from `../../src/core/` and `../../src/viewmodel/` (source-relative, not via package exports). This gives instant HMR without vite aliases or rebuild cycles. After the ARCH-1 fix (2026-07-20), every symbol web consumes from `src/` is also a public package export — the boundary is clean informally without enforcing it at build time.
- **`web/` is type-checked by `check:bridge-web`, not the root `tsgo --noEmit`.** Vite builds without type checking and the root tsconfig excludes `web/`, so `web/tsconfig.json` (DOM lib, `react-jsx`, `vite/client` types) exists solely as a `--noEmit` gate, wired into the root `npm run check`. Keep new browser code under `web/src/` so the include picks it up.
- **`prompt` always uses `streamingBehavior: "steer"`.** Without it, `AgentSession.prompt()` throws when a turn is in-flight (`agent-session.ts ~L1122`). `abort`/cancel is plumbing-available (pi's `AbortController`) but not surfaced in the web MVP yet.
- **Web styling invariants live in ADR 07 §Styling invariants.** Token authority, relative inline sizing, one-spec-per-role, and scoped Streamdown overrides. Read before adding a new button/chip/Markdown host to `web/`.

## Out of scope / deferred

- Out-of-process (jsonl-tail) adapter for attaching to an already-running pi.
- Wire protocol schema versioning / `sequence` on `Patch` (WebSocket reliable-ordered is sufficient; reconnect uses full `replace` snapshot).
- Multi-writer collaborative steering (last-write-wins or CRDT). Steering is single-writer (with `streamingBehavior: "steer"`, see Invariants).
- Auth/network posture. localhost-only; remote colleagues use SSH port-forward or a tunnel.
- An inverse `check:node-smoke` gate. Parked as an optional follow-up.
- Cross-tab registry sync. `active_sessions_changed` is a global push and `sessions_changed` is a Project-scoped push, so a session started/collected in tab A reaches tab B's launcher. Project configuration is static, so there is no project-list push to miss.
- A per-attachment failure push for an activation that dies while attached. ADR 11 removes `instance_exit` and exposes no activation lifecycle, so such a Connection stalls on a frozen attachment until reconnect re-resolves the address. See ADR 11 §Implementation notes.
- Assistant variant pager (regenerate alternatives). v1 shows variant pager on user messages only.

## Tests

All tests passing. Tests are a first-class design concern, not an afterthought. See `docs/architecture.md` §6 for the rationale.

- **Raw-object mode** — tests subscribe to `manager.onPatch` in-process, not over WebSocket. The Manager callbacks are the integration-test seam. There is no `onReplace`: a replace is just the first initial-sync frame at `addConnection`.
- **Faux provider + fixture resume** — no real provider APIs or paid tokens. Harness injects faux deps + fixture-resumed `SessionManager` into the production `createManager` path.
- **Integration tests resume real pi instances** from jsonl fixtures and drive faux-provider turns through the full event pipeline. This catches event-ordering and interleaving bugs that unit tests on `applyEvent` alone cannot reproduce.

Test files: see `test/suite/`. Categories:
- **Integration** — resume fixtures + drive faux-provider turns through full event pipeline.
- **Unit** — pure functions and mirror logic with hand-built inputs.

Full fixture/harness detail in `test/suite/harness.ts`.

## Entry-point map

### `src/core/` — pure, browser-safe

- `src/core/types.ts` — wire-safe types: `Document`, `Entry` union (11 variants — incl. `bash_execution`, the user-initiated shell-run entry projected from pi `bashExecution` messages; live via `entry_appended`, durable via `reconcile`; `EntryBase.ord` — ADR 09 file position), `Status`, `Patch`/`PatchOp` (json-patch + `append`), wire protocol (dual channel: push `replace`/`patch` + RPC call/reply; a `replace` always carries a `SessionRef`, a `patch` carries one only when it is a cursor-aware initial sync; `readFile` verb — fresh disk read for the web file viewer), `RpcRequest`/`RpcReply`, ADR 11 address types (`ProjectInfo`, `SessionAddress`, `SessionRef`, `SessionListCursor`) and `SessionInfo` (`projectId` + `stem` + `active`/`isStreaming` + durable `sessionId`), `PrefixCursor`, `ModelInfo`, `LAZY_FIELD_PATTERNS`, `isLazyFieldPath`
- `src/core/document.ts` — pure functions: `applyEvent(doc, event) → Patch | null`, `reconcile(doc, entries, opts?) → Patch | null` (index walk assigns `Entry.ord`; a discovered earlier hole also assigns positions to already-known later entries), `initFromEntries(entries) → Document`, `applyPatch(doc, ops)`, `computeObjectDiff(old, new, path)` (recurses into nested objects *and* arrays element-wise: new trailing element → `add` at the new last index; element string-field suffix → `append` on `/arr/<i>/field`; removals high-to-low), `projectSnapshot(doc)`, `filterPatchForSocket(ops, subs)`, `CompactCodec` (stateful WS-transport compaction — consecutive single-op `append` patches to the same path emit as bare JSON strings; decoder restores the op; invariants: prime-first, reset on `replace`/non-append/multi-op/`move`/RPC-reply; see ADR 06 §Push), `resolveFieldPath`, `getAtPath`, `setAtPath`
- `src/core/cache.ts` — pure ADR 09 cache policy: `computeCursor(records) → PrefixCursor | null` (contiguous-prefix derivation; gaps/duplicates/mixed sessions yield null), `projectCacheEntry` (deterministic lazy-stripped projection), `planCacheWrites(sessionId, before, after)` (structural-sharing selection of changed/new committed entries with `ord`), `seedDocument(records, statusHint)`, `cacheRecordsOfDocument`/`statusHintOfDocument` (replace-path record set + paint hint), `EntryCacheStore` interface + `InMemoryEntryCacheStore` (test seam; the IndexedDB adapter is web-only)
- `src/core/sync.ts` — pure ADR 09 initial-sync construction: `validateCursor(piEntries, cursor, sessionId)`, `buildInitialSync(doc, piEntries, session, cursor) → PatchMessage | ReplaceMessage` (delta multi-op patch for a valid cursor, full replace otherwise; both carry the `SessionRef`; mid-turn pairing excludes committed entries still held as provisionals). A `patch` carrying `session` is never compacted (`CompactCodec.singleAppendOp` bails on it).
- `src/core/git-stamp.ts` — pure ADR 10 stamp contract: `GIT_STAMP_CUSTOM_TYPE`, `GitStampData` (v1+v2 union)/`GitIdentity`, payload parsing/validation (`parseGitStampData`, `parseGitStampEntry` — accepts both pi `type` and bridge `kind` entry flavors; invalid v2 subjects clear to null, never reject the stamp), `parseCommitSubject`, `parseGitIdentity` (raw git plumbing output), `sameGitIdentity` (transition key — subject and anchor never participate)
- `src/core/client.ts` — `DocumentMirror` class: client-side mirror with `applyReplace`, `applyPatch`, `needsPull`, `ingestPullResponse`. `BridgeClient`: typed RPC + push demux wrapping `DocumentMirror`; holds a `CompactCodec` and routes incoming wire through `decodeIncoming` so bare-string (compact) frames restore to `append` ops before the mirror sees them
- `src/core/index.ts` — barrel re-export of all types and functions

### `src/viewmodel/` — pure, browser-safe

- `src/viewmodel/index.ts` — `computeViewModel`: leaf-path projection, run merging (consecutive assistant entries collapse into one turn per run — text does not split; turns are keyed by `turnKey`, which equals `entryId` unless a turn starts mid-entry), sibling computation, step-summary extraction, `newestLeafInSubtree`, `segmentBlocks`, `stepWants`, `resultPullPaths`, ADR 10 fold (`UserTurn.gitIdentity` + `gitCommitSubject` carried from the last valid stamp on the path; prompt stamps render no card — the chip is the UI), one standalone `GitChangeTurn` per other boundary stamp (user-bash / orphan run anchors), and mid-run stamps (`tool_end`/`turn_end` with an open run) folded into the run as `GitChangeMark`s (`AssistantTurn.gitChanges`, positioned by `afterBlockKey`; `assignGroupGitChanges` distributes them to action groups).
- `src/viewmodel/tree.ts` — git-log-style branch graph. Pass 1 `computeHistoryTree` (Document → user-message tree, skipping non-user entries via `parentId` walk) + `computeActiveUserPath` (root→leaf user-message set) + Pass 2 `computeLaneLayout` (lane-based, not depth-based: primary child inherits the parent's lane so linear follow-ups stay vertical; secondary children reuse a freed lane strictly above the parent's or a fresh rightmost lane so forks always sweep right; lane freeing deferred until the owning node's last child). Pure, browser-safe.

### `src/host/` — Node-only

- `src/host/manager.ts` — `createManager(options)`: injectable factory (test seam); owns one pi runtime + canonical `Document` for exactly one session (an activation is never rebound); `options.sessionPath` resumes a file, otherwise a fresh unflushed session is allocated. Bundles the ADR 10 git-stamp extension (`gitStamps: false` disables — test seam); exposes typed session verbs (`prompt`, `executeBash` (user `!` command — also the ADR 10 `user_bash_end` observation boundary), `abort`, `discardSteer`, `setModel`, `setThinkingLevel`, `renameSession`, `navigate`, `dispose`) and `onPatch`/`onSettled` callbacks plus `ConnectionHandle`-based `addConnection(handle, session, cursor?)`/`removeConnection(handle)` (initial sync at attach: cursor delta when the cursor validates, otherwise replace — ADR 09). Exposes `liveSessionId`, `cwd`, `sessionFile`, `createdAt` for the daemon's stem derivation and GC.
- `src/host/projects.ts` — ADR 11 Project configuration: `parseAllowEntry` (`<path>` / `<id>=<path>`, first `=` split), `canonicalizeCwd` (resolve + realpath, reject missing/non-directory), `deriveProjectId`, `buildProjects` (id validation, duplicate-id and session-storage-collision rejection), `normalizeStem` (canonical relative stem; rejects NUL/absolute/`.`/`..`/`.jsonl`), `resolveStemPath` (containment via filesystem resolution of existing targets), `stemFromSessionPath`.
- `src/host/git-stamp-extension.ts` — ADR 10 writer: `createGitStampExtension(deps?)` / `createGitStampExtensionWithTrigger(deps?)` inline-extension factories (serialized observations at `message_start`-user/`tool_execution_end`/`turn_end`; the WithTrigger bundle also exposes the host-side `user_bash_end` trigger; path-derived baseline, direct git-plumbing spawns so exit-1 stays distinguishable from spawn failure, best-effort subject query; `runGit`/`timeoutMs` injectable for tests)
- `src/host/connection.ts` — `Connection`: owns one WebSocket, attached to at most one Manager; `attach(mgr, session, cursor?)`/`detach()` (attach resets the `CompactCodec`); demuxes incoming RPC frames (session verbs → (attached) Manager; navigation verbs `openSession`/`newSession`/`detach`/`closeSession` → Daemon; query verbs `listSessions`/`listActiveSessions`/`getDaemonInfo` → Daemon; `listFiles`/`readFile`/`gitShow` require an attachment because relative paths resolve against the attached session's Project cwd; connection-local `pull` → self); filters patches against per-connection subscriptions (cleared on every initial-sync frame); `push(frame)` lets the daemon deliver `sessions_changed`/`active_sessions_changed`; routes outgoing through a `CompactCodec`
- `src/host/daemon.ts` — `Daemon`: singleton with `start()`/`dispose()`; materializes Projects from `--allow` entries; owns the activation registry (`activations`, `activationByAddress`, `pendingActivations`, `gcTimers` via the activation, `sessionOwnerById`) and the Connection list; handles `openSession` (resolve-or-create keyed by `addressKey`; a collecting activation is awaited and the reservation retried), `newSession` (fresh unflushed session), `detach`, `closeSession` (explicit kill — disposes the activation now, ignoring idle GC policy, streaming state, and attachments; shared `collectActivation`/`disposeActivation` path with idle GC), `listSessions` (recursive scan + live activations, mtime/header time ordered, compound cursor), `listActiveSessions`, `getDaemonInfo` (Projects), `listFiles`, `readFile` (capped at 256 KB; `readHostFile` exported for Connection-level tests), `gitShow` (hex-validated commit, capped and timed; `runGitShow` exported for tests); GC policy is `idleGcMs`/`unflushedIdleGcMs` (injectable test seam; not user-configurable); broadcasts `sessions_changed` (Project-scoped first page) and `active_sessions_changed` (global); serves the SPA shell for `/launcher` and `/chat/...`; runs the WS/HTTP server

### Entrypoints

- `src/index.ts` — root export: all types + `BridgeClient`, `DocumentMirror`, `CompactCodec`, `applyEvent`, `applyPatch`, `reconcile`, `initFromEntries`, `projectSnapshot`, `filterPatchForSocket`, `isLazyFieldPath`, `LAZY_FIELD_PATTERNS`, `resolveFieldPath`, `getAtPath`, `setAtPath` (browser-safe `core`)
- `src/node.ts` — `./node` subpath re-export: `Daemon`, `DaemonOptions`
- `src/cli.ts` — `pi-bridge` binary entrypoint: parses `--port`/`--log`/`--dev`/`--allow <[id=]dir>`/`--web-root`, starts a `Daemon`
- `web/` — React + Vite client; built by `vite build`, not `tsgo`. Consumes the wire protocol (push `replace`/`patch` + RPC call/reply) via `DocumentMirror` + `BridgeClient`, with lazy pull orchestration. Renders all 10 entry types with foldable detail views and a debug pane.
	- Layered: `app/` (shell — `App`, `main`, `index.css`, `ToastBar`), `infra/` (store + connection/RPC/pull-loop plumbing), `render/` (shared `markdown`/`CodeSnippet`/`shiki`), and `features/<area>/` (`launcher`, `topbar`, `sidebar`, `conversation`, `composer`, `history`, `viewer`). Each feature folder co-locates its components + `.module.css`; `web/` reaches into `src/core` and `src/viewmodel` by design (source-relative, for instant HMR).
	- `web/src/infra/store.ts` — Zustand `createClientStore()`: single source of truth for the web UI. Holds `Document` + `activeSessionId` (ADR 09 cache key, set from initial-sync frames), the current address (`currentProjectId`/`currentStem`), the static `projects` list and global `activeSessions` snapshot, connection state, UI expand/freeze state, the composer `draft` (idle/compose/edit discriminated union — the single source of truth for the textarea content), the current Project's session page (with its compound cursor), and pull orchestration state (`loadingPaths`, `pullTick`). `clearCurrentSession` is the one teardown (detach / Project switch / failed open); there is no pin flag because the URL is the navigation source of truth. `store.ts`/`store.tsx` stay split so `store-unit.test.ts` imports the factory without React. Sibling infra modules: `client.ts` (singleton `BridgeClient`), `routes.ts` (URL ⇄ address projection; `parseRoute`/`writeRoute`), `addressIndex.ts` (`(projectId, stem) → sessionId` localStorage map so a cold load can find the ADR 09 cache cursor), `useConnection.ts` (WS lifecycle + `onPush` + connection-state machine + route-driven boot/reconnect + ADR 09 cache write-through), `useRpc.ts` (verb wrappers; `openSession`/`newSession`/`detach` seed candidate mirrors and send cursors; `closeSession` terminates a live instance and falls back to the Project home when the viewed session died), `entryCache.ts` (ADR 09 IndexedDB cache adapter + `prepareSwitch`; DOM-typed, not importable from `test/suite`), `sessionCandidate.ts` (ADR 09 candidate-mirror registry for live opens; DOM-free, unit-tested), `pullLoop.ts` (wants-outbox drain), `draftPersistence.ts` (`useDraftGuard` — per-session `localStorage` draft persistence + `beforeunload` warning).
	- `web/src/features/history/HistoryPane.tsx` — git-log-style branch graph of user messages, as a docked right pane (desktop) / right drawer (mobile) toggled from the TopBar's right edge. Publishes `--history-w` so the TopBar (`right` binding) and `.body` (right gutter) clear it. Renders the `LaneLayout` (Pass 1+2 viewmodel) as an SVG layer (vertical lineage `<line>`s + cubic-Bezier fork `<path>`s) under positioned DOM rows (dot + message preview + time). Clicking a node navigates to the newest leaf of its subtree and sets `scrollToEntryId` so `ConversationArea` anchors to the message; during streaming, on-path clicks are look-only (anchor-scroll, no branch) and off-path clicks are disabled until the reply settles. Fixed row height keeps SVG coordinates computable upfront.

### Tests

- `test/suite/harness.ts` — `createBridgeHarness(options)`: builds `createManager` with faux deps, fixture-resumed `SessionManager`, custom tools, tokensPerSecond, settings. Returns `{ manager, faux, patches, ops, hasOp, cleanup }`.
- `test/suite/daemon-activations.test.ts` — daemon Project/activation integration: id validation + startup rejection, `newSession`/`openSession` sharing and reattach, stale-address rejection, idle GC (attached vs detached), compound-cursor pagination, and the session broadcasts. Uses the injectable `managerFactory` seam with stub Managers.
- `test/suite/initial-sync-integration.test.ts` — initial sync through Manager + Connection + Daemon: cursor pass-through, per-handle emission, subscription reset, and the `SessionRef` on the wire.
- `test/suite/navigation-e2e.test.ts` — end-to-end navigation (branch/leaf) through the full Manager+FauxProvider stack.

Pi primitives reused from `@earendil-works/pi-coding-agent`:

- `createAgentSessionRuntime`, `createAgentSessionFromServices`, `createAgentSessionServices` from `agent-session-runtime.ts`
- `SessionManager.open(path, sessionDir?, cwdOverride?)` from `session-manager.ts`
- `AgentSessionEvent`, `AgentSessionEventListener` from `agent-session.ts`
- `AuthStorage.inMemory()`, `ModelRegistry.inMemory()`, `SettingsManager.inMemory()` for injected test deps
- `registerFauxProvider` / `fauxAssistantMessage` / `fauxToolCall` from `@earendil-works/pi-ai/compat`

## Package-local commands

From `packages/bridge/`:

```bash
npm run build          # tsgo -p tsconfig.build.json (core/host/cli)
npm run build:web      # vite build --config web/vite.config.ts web
npm run build:binary   # build + build:web + bun build --compile
npm test               # vitest --run
node ../../node_modules/.bin/tsgo --noEmit -p web/tsconfig.json  # type-check web/ only
node ../../node_modules/vitest/dist/cli.js --run test/suite/<name>.test.ts  # single test
```

The root `AGENTS.md` covers the global `npm run check` / `./test.sh` workflow.
