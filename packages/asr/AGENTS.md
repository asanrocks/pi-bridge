# pi-asr

A TypeScript client for the Doubao IME streaming ASR endpoint: L1 wire, L2
editing, L3 text fields, and one dictation orchestrator. Repository-wide
development, Git, dependency, and release rules live in
[the root guide](../../AGENTS.md).

## Read for the task

- Layer table and public entries: [README.md](README.md).
- Wire facts, evidence grades, and `§` citation targets:
  [docs/protocol.md](docs/protocol.md) is the single authority.
- The host contract (credentials, audio, editing, failures):
  [docs/integration.md](docs/integration.md).

## Non-negotiable constraints

Each one is a measured property of the service, not a style preference. Changing
one requires re-running a probe and updating `docs/protocol.md`.

- **Constructor starts nothing.** `new AsrSession()` must not open a socket;
  `connect()` does. Audio pushed before the handshake completes waits in a
  bounded pre-roll (500 ms default).
- **One server message = one event.** `results[]` is surfaced whole, never
  merged, deduplicated, or "best-track" picked. L1 computes the wire-specific
  `final` flag; presentation policy stays out.
- **Interim text can only replace a span.** `results[0]` is a cumulative track
  that shrinks, moves, and gets re-punctuated. Read it and replace wholesale —
  never append.
- **Exactly one final per session, and no tail silence.** `tailMs` defaults to 0.
- **Auth is bound to the wire format.** A SAMI token works only on the JSON wire;
  protobuf requires `{ device }` with a registered `device_id`. Reject the
  combination at config time, never at handshake.
- **Browsers cannot use protobuf.** The switch is the `proto-version: v2` request
  header, which page JS cannot set. The browser entry fails `wire: 'protobuf'`
  as `unsupported`, never silently downgrades.
- **`push()` never throws.** It runs inside audio callbacks. Out-of-bounds pushes
  drop the frame and emit one `expired` error.
- **Sessions expire on silence** (~20 s; ≤18 s verified usable). `finish()`
  reports `expired: true` rather than pretending success.
- **Terminal message and final transcript can arrive in either order.** Keep the
  `terminalGraceMs` wait (250 ms default).
- **Transport is injected.** Never reference the global `WebSocket` outside
  `src/transport.ts`. The microphone and the session factory are orchestrator
  options, not imports.
- **`listening` starts at the first audio batch.** Not at a level threshold (noise
  suppression removes the room floor, §5.7) and not at the handshake: a late
  handshake is `listening` with `sending: false`, because the pre-roll already
  keeps the audio.
- **A new module is a layer only when it translates a new kind of knowledge.**
  Ordering is not knowledge: there is exactly one orchestrator (`src/dictation/`).
  Appearance, layout, icons, hotkeys, and settings belong to consumers.

Structural rules: zero runtime dependencies (dev-only), the package never writes
to stdout/stderr, and React/rich-text adapters are deliberately absent — those
must use their own transaction APIs. Do not add them here.

`src/mic/worklet.js` is the one file outside type checking: it runs in the audio
rendering thread, is loaded by URL, and must ship as the file the URL names.
`scripts/copy-assets.mjs` copies it into `dist/` because `tsc` emits only `.ts`.
Do not convert it to TypeScript: a `.ts` source is only called `worklet.js` after
a build, which breaks consumers resolving the package from `src/`.

Files that use DOM globals carry `/// <reference lib="dom" />`. The package
build inherits the root lib (`ES2024`, no DOM), so a new browser-only file needs
the directive; a new Node-only file must not pull DOM code in through the entry
graph.

## Commands

From this directory:

```sh
npm run build        # tsc -> dist/, then the worklet copy
npm run typecheck    # src + test, with exactOptionalPropertyTypes and noUncheckedIndexedAccess
npm run test         # offline suite (excludes test/e2e)
PI_ASR_E2E=1 npm run test:e2e   # live service; self-registers a device, needs no secret
npm run demo         # build, compile the demo page, serve it on 127.0.0.1:8787
```

From the repository root: `npm run check` (biome, dependency gates, entry-graph
budgets, asset paths, root `tsc`), and `./test.sh` for every non-e2e test.

The gates that keep the layer table real:

| Gate | Where | Fails when |
| --- | --- | --- |
| entry graphs | root `scripts/check-entry-graphs.mjs` (`packages/asr` budgets) | an entry reaches a file its layer must not know (`./browser` → `token.ts`, `./edit` → `dom/`, …) |
| asset paths | root `scripts/check-asr-assets.mjs` | a `new URL(…, import.meta.url)` target is not beside its source, or a path names `dist/` |
| strict flags | root `check:asr-types` | `tsconfig.json` stops compiling under `exactOptionalPropertyTypes` / `noUncheckedIndexedAccess` |
| browser bundle | root `scripts/check-browser-smoke.mjs` | `./browser` pulls a `node:` builtin, the credential helpers, or the DOM adapter |
| DOM lib | root `tsc --noEmit` | a browser-only file uses DOM globals without the reference directive |

## Testing

- The default suite must stay offline and deterministic. Anything that opens a
  socket belongs in `test/e2e/*.e2e.test.ts`, gated on `PI_ASR_E2E === '1'`, and
  must stay excluded from `vitest.config.ts`.
- A public API change updates `docs/integration.md` in the same change: that
  file is the host's contract, and the gates only check what a machine can.
- Drive L1 through `MockTransport` (`src/testing/mock-transport.ts`) by pushing
  captured server frames; assert on decoded values, not snapshots.
- The suite runs in Node; there is no DOM emulator. L3 is driven through
  `FakeTextField` (`test/helpers/fake-element.ts`), which supplies or withholds
  `execCommand` per test, so both the native-undo and `revertLast()` branches
  stay covered. "Unsupported" is a normal outcome, not an error case.
- The orchestrator injects both halves (`openMic`, `createSession`): drive it
  with `FakeMic` over `MockTransport`, and the affordance with a structural
  `Dictation` double over `FakeButton`. Never stub the Web Audio globals to test
  the controller: phases and timing are what the tests are about.
- Every bug fix lands with the test that would have caught it, and with the
  measured evidence in the commit body when the fix depends on server behaviour.

## Code conventions

- TypeScript with `nodenext`, `verbatimModuleSyntax`, `erasableSyntaxOnly`,
  `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `strict`. No `enum`,
  parameter properties, or namespaces; use `as const` objects like
  `ServerStatus`. Indexed access yields `T | undefined` — handle it instead of
  asserting (`!` is allowed only in tests).
- Relative imports carry the `.ts` extension in source; the build rewrites them
  to `.js`. Type-only imports use `import type`.
- Format and lint with the root biome configuration (tabs, width 120,
  semicolons). Fix findings; no disable comments without a one-line reason.
- Comments explain intent and trade-offs, not mechanics. File headers state what
  the file owns, what it refuses to do, and why.
- Error paths go through `AsrError` with a stable `code`; server status codes
  stay in `ServerStatus`.

## Protocol work

The service is undocumented and can change. Workflow for any wire-level change:

1. Reproduce with `tools/protocol-probe/` (browser via CDP, Node, or the Rust
   probe) and record the exact environment. Install dependencies from the
   repository root; the probe is a private workspace package.
2. Update `docs/protocol.md`, keeping the evidence marker honest: ✅ reproduced
   this round, ⚠️ single observation, ✗ unverified. Correct the decision table
   in §0 when a conclusion flips.
3. Adjust code and tests; keep the `§` citations next to the code they justify.
4. Note the measurement in the commit body, including what was verified and what
   was not.
