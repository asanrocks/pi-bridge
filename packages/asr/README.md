# @earendil-works/pi-asr

A TypeScript client for the Doubao IME (豆包输入法) streaming ASR endpoint. Rebuilt
layer by layer, each layer independently testable:

| Layer      | Entry point                                                       | Owns                                                                                                      | Refuses to                      |
| ---------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------- |
| L1 wire    | `@earendil-works/pi-asr` (`/browser`, `/node` add a provider each) | Both wire codecs, auth, audio framing, and the lifecycle. One server message = one event, `results[]` whole | Merge text, touch the DOM       |
| L2 editing | `@earendil-works/pi-asr/edit`                                     | Preedit, atomic commit, minimal diff, undo grouping, cancel, drift detection                              | Know about the wire or the DOM  |
| L3 textbox | `@earendil-works/pi-asr/dom`                                      | The `input`/`textarea` adapter, the `attach` seam, IME-shaped events, native undo                         | Know about the wire protocol    |

Two providers sit beside the layers and translate the physical world:
`openMicrophone` (hardware → 16 kHz PCM) and `Transport` (socket → frames); both
are injected, never imported by their consumer. One orchestrator,
`@earendil-works/pi-asr/dictation`, sequences the three layers with both
providers — it is not a layer, because ordering is not knowledge.

`@earendil-works/pi-asr` is runtime-neutral and does not resolve differently per
platform: a caller that wants the microphone imports
`@earendil-works/pi-asr/browser`, and one that mints credentials imports
`@earendil-works/pi-asr/node`. Conditions on the root entry would decide that
silently, and the wrong answer is a page that loads `getUserMedia` code it never
asked for.

`@earendil-works/pi-asr/protocol` exports the plain-function codecs on their own,
for extensions, same-origin relays, and replay-style tests.
`@earendil-works/pi-asr/testing` exports the transport and microphone doubles,
so a host can drive the real session offline instead of approximating the wire.

For field-level details, measurements, and disproved claims, see
[`docs/protocol.md`](docs/protocol.md).

## Status

Rebuilt layer by layer, each with its own offline tests:

- [x] L1 wire: codecs, auth, audio pipeline, framing, session state machine (79 tests, all over a mock transport)
- [x] L2 editing: preedit / minimal diff / commit / undo grouping / `StringEditHost`, drift detection (33 tests, DOM-free)
- [x] L3 textbox: `input` / `textarea` (13 tests, fake field)
- [x] Microphone provider: device rate → 16 kHz mono PCM (10 tests, stubbed globals)
- [x] Orchestrator: phase machine, level meter, hold/toggle/auto button binding (32 tests, fake mic + mock transport + fake button)
- [x] End-to-end integration test (the only suite allowed to hit the real server: register device → push audio → L2 commit; both wire formats covered)

## L1 usage

```ts
import { AsrSession } from '@earendil-works/pi-asr/node'

const session = new AsrSession({ wire: 'json', auth: { token } })
const ready = session.connect()

session.push(micPcm) // audio during the handshake goes to pre-roll, no words lost
await ready
session.push(morePcm)

for await (const event of session.events) {
  // open / message / results / text / heartbeat / error / closed
}
const { text, timedOut, expired, error } = await session.finish()
```

Recording is a provider, not an extra layer: it produces the 16 kHz mono PCM
that `push()` consumes and knows nothing about the wire. It lives in the browser
entry because `getUserMedia` does.

```ts
import { AsrSession, openMicrophone } from '@earendil-works/pi-asr/browser'
import { DictationEdit } from '@earendil-works/pi-asr/edit'

const session = new AsrSession({ wire: 'json', auth: { device } })
const edit = new DictationEdit(host) // an EditHost: a text field, or a store

const ready = session.connect()
const mic = await openMicrophone({ onPcm: (pcm) => session.push(pcm) })
edit.begin(caret)

// The pump runs alongside the user, never before finish(): the event iterator
// only ends when the session closes, so awaiting it first would deadlock.
const pump = (async () => {
  for await (const event of session.events) {
    if (event.type === 'text' && event.track === 0) edit.update(event.text)
  }
})()

await ready // …the user speaks, `pump` keeps the pre-edit up to date…
await mic.stop()
const { text } = await session.finish()
text === null ? edit.cancel() : edit.commit(text)
await pump
```

A document that lives in application state needs no adapter: `StringEditHost`
(`@earendil-works/pi-asr/edit`) holds the text and the caret, applies batches through
`applyBatch`, and reports the caret so no `caret()` option is needed.

```ts
import { StringEditHost } from '@earendil-works/pi-asr/edit'

const host = new StringEditHost({ text: draft, caret: 0 }, { onChange: setDraft })
// The user types into the store while a dictation runs:
host.setText(nextDraft, nextCaret)
```

`openMicrophone` takes an optional `batchMs` (how often the audio graph posts
samples, default 20) and `audio` constraints; the wire's own frame cadence is
`frameMs` on the session. They are independent, and `Resampler` absorbs the
difference. `onEnded` reports a device that vanished on its own, and `workletUrl`
overrides the worklet module — bundlers that rewrite `import.meta.url` need it.

## Dictation usage

`@earendil-works/pi-asr/dictation` is that same wiring, once: a phase machine, a level meter,
and the bindings a button needs. It sequences the layers below without adding
protocol or editing semantics, so two consumers with a text field apiece do not
each re-implement the lifecycle.

```ts
import { Dictation, bindButton } from '@earendil-works/pi-asr/dictation'
import { attachInput } from '@earendil-works/pi-asr/dom'

const field = document.querySelector('textarea')!
const target = attachInput(field)
const dictation = new Dictation({
  // `getToken` is resolved lazily, once per utterance, inside `connect()`.
  session: () => ({ wire: 'json', auth: { getToken: () => mintToken() } }),
  host: target, // any `EditHost`: `attachInput`, `StringEditHost`, or your own
  // `auto` holds under a finger or a pen and latches under a mouse or a key.
  mode: 'auto',
  // §5.7: echo cancellation costs recognition quality, noise suppression helps.
  mic: { audio: { echoCancellation: false, noiseSuppression: true } },
})

const detach = bindButton(field.parentElement!.querySelector('button')!, dictation)
```

The button receives only three things: `phase` (`idle` / `preparing` /
`listening{sending}` / `committing` / `failed`), a ~50 Hz `onLevel` stream, and
`data-state` / `data-sending` / `data-speaking` / `--asr-level` to style
against. It writes no stylesheet and never takes focus, so a page keeps its
layout and a compose field keeps its draft.

Consumers that own their own component tree (React, for instance) render the
button themselves and subscribe: `phase` for `useSyncExternalStore` and
`onLevel` into a ref, because a 50 Hz level must not go through a store.
`onSettled` is the third channel and the one a host reports on: one
`DictationResult` per utterance — committed, cancelled, expired, timed out, or
failed — delivered once, after the text is in the field. `isFatalError`
separates the endings that need a failure surface from the advisory ones.

Behaviour worth knowing:

- `listening` begins at the **first audio batch**: not at a level threshold (noise
  suppression removes the room floor, so a quiet room never crosses one) and not
  at the handshake, which would report a working microphone as still preparing.
  `preparing` therefore means "no audio yet", and `listening.sending === false`
  means "capturing, frames still in the pre-roll".
- A release before the handshake finished is a **cancel**, not an empty session.
- Cancellation outranks the server's answer: `cancel()` while the terminal
  transcript is in flight removes the pre-edit and discards that transcript, so
  an abandoned utterance never writes into the field that replaced it. `isActive`
  stays true until the answer lands, so the button cannot start a second one.
- Expiry after ~20 s of silence is a normal ending: the text is committed, the
  button returns to `idle`, and `dictation.error.code === 'expired'`.

A few hard constraints, by design:

- **Construction is separate from `connect()`**: capture starts on key-down, auth
  and handshake run in parallel, and audio waits in a bounded pre-roll (500 ms
  default). This is the first-word latency path, not an optional optimisation.
- **One server message = one event**, with both `results[]` tracks surfaced
  whole; `final` on a `text` event only reports that wire format's own terminal
  criterion (`docs/protocol.md` §6.3), never a merge policy.
- **Transport is injectable**: the runtime `WebSocket` by default; tests and
  relays swap in a fake through `transport`. The browser entry has no header
  capability, so `wire: 'protobuf'` is rejected as `unsupported` rather than
  silently downgraded.
- **Tail silence defaults to 0**: measurement says it is unnecessary, and the two
  wires close differently because only one has a state to close — protobuf ends
  with a silent frame carrying `frame_state: last`, JSON just flushes the audio it
  has. `tailMs` is kept for the future.
- **Auth is bound to the wire format**: a static `token` / `getToken()` works
  only on the JSON wire (the server rejects a SAMI token on protobuf with
  `40200001`), while protobuf must use `device` (app key + a registered
  `device_id`). This fails at config time, never at handshake.
- **The server expires sessions on silence** (measured: ≤18 s of pre-connect is
  usable, ≥21 s is already finished): an out-of-bounds `push()` does not throw
  (a throw inside an audio callback kills capture), it drops the frame and emits
  one `error` (`expired`), and `finish()` reports `expired: true`.
- **Every failure is one shape**: `AsrError` carries `code` (including `capture`
  for microphone permission and device failures), the raw `status` when it came
  back in-band, and a `retryable` hint (§7.1). `finish()` returns
  the same object as `outcome.error` — an in-band failure, an expiry, or the
  finish wait timing out — so a caller branches on the hint instead of
  re-deriving meaning from `timedOut`/`expired`.
- **The terminal message and the final transcript are not ordered**:
  `terminalGraceMs` (250 ms default) waits briefly for the final after
  `TaskFinished`/`SessionFinished` instead of losing it.

## Commands

From this directory (the repository root has its own `npm run check`):

```sh
npm run build        # tsc -> dist/, then the worklet copy
npm run typecheck    # src + test, with the package's strict flags
npm run test         # offline suite (175 tests, excludes test/e2e)
PI_ASR_E2E=1 npm run test:e2e   # real server, self-registers a device, needs no secret
npm run demo         # build, compile the demo page, serve it on 127.0.0.1:8787
```

Toolchain: the monorepo's TypeScript, biome, and Vitest. The package adds
`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` in its own
tsconfig; the root `tsc --noEmit` type-checks the same sources with the shared
settings.

## L2 usage

```ts
import { DictationEdit } from '@earendil-works/pi-asr/edit'
import type { EditBatch } from '@earendil-works/pi-asr/edit'

const edit = new DictationEdit({ apply: (batch: EditBatch) => hostApply(batch) })
edit.begin(caretOffset)
edit.update('hello, I am') // only the changed span is emitted
edit.update('hello, I am Doubao IME') // may shorten or re-punctuate
edit.commit('Hello, I am Doubao IME.') // one commit for the whole span = one undo group
```

Semantics:

- A **preedit** batch carries concrete ops; a **commit** batch has empty `ops`
  and means "the current preedit is now durable", so the host ends the
  composition and records the group as one undo step; a **cancel** batch
  retracts it.
- A host whose document is a plain string (a store, a model buffer, a test
  double) does not need to interpret ops at all: `applyBatch(text, batch)`
  returns the new text, and `batch.span` says where the caret belongs.

```ts
import { applyBatch } from '@earendil-works/pi-asr/edit'
import type { EditBatch } from '@earendil-works/pi-asr/edit'

let text = ''
let caret = 0
const host = {
  // `read` is what makes an external edit detectable: without it the model
  // cannot tell that offsets slid, and the next diff rewrites the wrong range.
  read: () => ({ text }),
  apply: (batch: EditBatch) => {
    text = applyBatch(text, batch)
    caret = batch.span.end
  },
}
```

- `update()` and `commit()` return `'applied' | 'cancelled' | 'dropped'`. A late
  result after the utterance ended is `'dropped'`, not an exception, because the
  server keeps sending until the socket closes. `'dropped'` also means the
  document changed under the dictation: the span is closed and nothing is
  written, so the user's edit survives.

- Undo is the host's decision: with a native undo stack, go through the
  `composition` events (see L3); without one, call `revertLast()` to get a batch
  of reverse ops. The `@earendil-works/pi-asr/dom` adapters keep the pre-edit out of the
  browser's history, so one native undo removes the committed utterance.
- Only one commit policy is supported: commit at the terminal transcript. The
  server has no reliable "segment settled" signal, so committing earlier would
  have to be papered over with retractions — not worth it
  (`docs/protocol.md` §6.5).

## L3 usage

```ts
import { DictationEdit } from '@earendil-works/pi-asr/edit'
import { attachInput } from '@earendil-works/pi-asr/dom'

const target = attachInput(input, { onExternalEdit: () => edit.cancel() })
const edit = new DictationEdit(target)

edit.begin(target.read().caret) // take the current caret
// …feed L1's text events into edit.update(text) in order
edit.commit(finalText) // or edit.cancel()
```

The host sees an **input-method-shaped event sequence**, not a script writing a
value:

```
compositionstart
input(insertCompositionText, isComposing: true) × every preedit update
compositionupdate
commit → compositionend + input(insertText, isComposing: false)
cancel → input(deleteCompositionText) + compositionend
```

One adapter, `attachInput` (`input`/`textarea`): it writes through `setRangeText`
and dispatches `input`, which is why React's value tracker sees the change. On
commit it clears the span and runs `execCommand('insertText')` at the collapsed
caret, making the whole span one browser undo step; where `execCommand` is
missing it falls back to `DictationEdit.revertLast()`.

The adapter clears the pre-edit outside the undo stack before `execCommand`
runs: what a command replaces is what undo puts back, so leaving the pre-edit
selected would make Ctrl+Z restore the text it just removed.

Not provided: a `contenteditable` adapter, a React component, and adapters for
specific rich-text editors (Slate/Lexical/ProseMirror). Those own their
transactions and implement the `EditHost` contract (`@earendil-works/pi-asr/edit`)
instead; writing the DOM directly would corrupt their history.

## End-to-end test

`test/e2e/` is the only place that touches the real service, and it does not run
by default:

```sh
PI_ASR_E2E=1 npm run test:e2e
```

It authenticates on its own (device self-registration needs no secret), pushes
`test/fixtures/hello.wav` as JSON envelopes plus raw PCM, and then asserts: the
final transcript L1 reports, that the L2 document equals that transcript (which
shows interim revisions were replaced rather than appended), that exactly one
commit batch was produced, and that a second run of pure silence neither errors
nor yields a transcript.

## Protocol constraints (engineering premises, not implementation choices)

Full fields and measurements are in [`docs/protocol.md`](docs/protocol.md); only
the parts that shape the package layout are repeated here:

- One endpoint, `wss://frontier-audio-ime-ws.doubao.com/ocean/api/v1/ws`, and
  protobuf is selected by the `proto-version: v2` request header; **browsers
  cannot set custom headers**, and both subprotocols and query parameters have
  been disproved, so a page can only use the JSON envelope. Node ≥22's built-in
  `WebSocket` supports `{ headers }`.
- Two auth paths: `sami_token` (requires `X-Api-Access-Key`, only mintable
  server-side) or a self-registered `device_id` plus the official IME's fixed app
  key (no secret needed, but it is a shared identity). None of the three auth
  endpoints send CORS headers.
- Audio must be binary frames. opus (`speech_opus`) is accepted on both wires at
  20/40/60 ms and is ~10× smaller than PCM; `raw_pcm` is the fallback for
  browsers without WebCodecs.
- Terminal state: `!is_interim && is_vad_finished` on protobuf, `is_interim ===
false` on JSON, exactly one per session. Tail silence is **not** needed.
- `results[0]` is the cumulative track for the whole utterance; it shortens and
  gets rewritten across segments. `results[1..]` are segment tracks and also
  carry `is_interim: false`. So interim text can only replace a span wholesale,
  and only `results[0]` may be read.

Probes and reproduction: `tools/protocol-probe/` (re-runnable), plus
`probe/README.md` (local notes, not tracked).
