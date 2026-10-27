# Integrating this package

What a host needs to know to embed dictation, written for the first such host
(pi-bridge's browser client) and kept honest by the gates listed at the end.

`docs/protocol.md` remains the authority for wire behaviour. This file is about
the boundary: which entries to import, who owns credentials, and which
decisions belong to the host.

## Entries

| Import                 | Contains                                                  | Reach for it when                              |
| ---------------------- | --------------------------------------------------------- | ---------------------------------------------- |
| `@earendil-works/pi-asr`           | L1 wire: session, codecs, framing, auth types, errors     | you bring your own transport and audio source  |
| `@earendil-works/pi-asr/browser`   | L1 + `openMicrophone`                                     | the host is a page and owns the microphone     |
| `@earendil-works/pi-asr/node`      | L1 + `registerDevice`, `mintSamiToken`                    | the host is a server and holds the credentials |
| `@earendil-works/pi-asr/protocol`  | plain codecs, no session                                  | a relay or a replay tool decodes frames        |
| `@earendil-works/pi-asr/edit`      | L2: `DictationEdit`, `StringEditHost`, `applyBatch`       | the document is yours (a store, a buffer)      |
| `@earendil-works/pi-asr/dom`       | L3: `attachInput`, `attach`                               | the document is an `input`/`textarea`          |
| `@earendil-works/pi-asr/dictation` | the orchestrator: `Dictation`, `bindButton`, `LevelMeter` | you want a button, not a state machine         |
| `@earendil-works/pi-asr/testing`   | `MockTransport`, frame builders, `FakeMic`                | you are testing a host that embeds the session |

The root entry is neutral: it never resolves to a platform entry. A page that
wants a microphone asks for `./browser`. A bundler that finds `getUserMedia` code
in a bundle nobody asked for is looking at a mistake, not a convenience.

## Credentials

The browser never holds a secret and never registers a device — the token
endpoint sends no CORS headers and the registration endpoint is not reachable
from a page (`docs/protocol.md` §1.3, §1.4). Two shapes are supported:

- **Server mints a SAMI token.** `mintSamiToken({ accessKey })` on the host, the
  token to the page, `auth: { token }` or `auth: { getToken }` in the session.
  The access key belongs to the host's deployment, never to this package and
  never to the page.
- **Server registers a device.** `registerDevice()` returns a shared, non-secret
  `deviceId`; the page passes `auth: { device }`. This needs no key at all, which
  is why the demo works out of the box.

Freezing one of these into the package would fork the auth path; §1.5 forbids it.

## Audio

`openMicrophone` produces 16 kHz mono PCM for `push()`. Two things a host must
provide around it:

- A **secure context**. `getUserMedia` needs `https:` or `localhost`; a daemon
  reached through a tunnel is neither.
- A **worklet URL** when the bundler does not handle it. The default is
  `new URL('./worklet.js', import.meta.url)`, which vite and webpack emit as an
  asset; a host that inlines or rewrites assets passes `workletUrl` instead. The
  worklet is same-origin, so `script-src 'self'` is enough — no `blob:` source is
  needed.

## Where the text goes

Two hosts, one contract (`apply(batch)` plus an optional `read()`):

- **A store-backed document** — a React composer, a model buffer — uses
  `StringEditHost`: give it the text and the caret, tell it about user edits with
  `setText`, and render `onChange`. No `caret()` option is needed, because
  `read()` reports one.
- **A text field** uses `attachInput`. It writes through `setRangeText` and
  dispatches `input`, which is what makes a controlled component's value tracker
  accept the pre-edit as typing.

Rules that are not stylistic:

1. **Do not write the field value yourself.** `setDraftText`-style assignment
   bypasses the native undo stack: the commit becomes un-undoable, or worse, one
   Ctrl+Z restores the pre-edit instead of removing the utterance. The adapter
   exists to keep that stack intact (`src/dom/native-undo.ts`).
2. **Do not accumulate transcripts.** Server text replaces the owned span; L2
   diffs it, and L1 already picked the track. Appending duplicates every revision.
3. **Route a foreign edit through the host.** If the user types or the store
   changes while a dictation is running, the model must see it (`setText`, or the
   field's own `input`). Otherwise `read()` cannot detect drift and an absolute
   offset rewrites the wrong range; with drift detected, the dictation drops
   itself and the user's text wins.
4. **One dictation at a time per host.** `Dictation.start()` while active is a
   no-op; two `DictationEdit` instances over one document are not supported.

A host may lock the field while an utterance runs, so nothing can be typed into
the span the dictation owns. `attachInput` lifts `readOnly` for the one
synchronous native commit and restores it afterwards, because a browser refuses
the edit command on a read-only field: the transcript would otherwise reach the
field through the fallback, visible but not undoable. Undo applies when the host
releases the lock — undoing while the field is still locked consumes the stack
step without applying it in Chromium, so release the lock as the utterance ends
(that is what `isActive` reports).

The lock does not have to be `readOnly`. A focused textarea that turns read-only
loses its IME connection on Android: the soft keyboard closes when the field
locks and reopens when it unlocks, and the unlock/restore pair inside the commit
adds two more transitions. Refusing `beforeinput` on the element blocks the same
edits (typing, paste, cut, drop) without touching editability, so the keyboard
never moves; leave the refusal off during `committing`, whose write is the
adapter's own `execCommand` call and would be swallowed by it. pi-bridge takes
that route.

## Lifecycle and failures

`Dictation.subscribe` reports five phases: `idle`, `preparing`, `listening`
(with `sending`), `committing`, `failed`. `listening` starts at the first audio
batch, not at a level threshold, and not at the handshake.

`onSettled` reports what an utterance produced: one `DictationResult` per started
utterance, delivered after the text outcome reached the host and after `phase`
and `result` were updated, so a listener can read what a user sees. It covers a
commit, a cancellation (the empty result: no text, no finish, no error), an
expiry, a finish timeout, and a failure. `isFatalError(result.error)` separates
the endings a host must surface from the advisory ones, so a host never
re-derives that classification from `code`. The phase subscription stays
separate because it reports UI states and says nothing about the transcript;
`dispose()` clears both, and the returned unsubscribe releases one listener.

`DictationResult.error` carries the reason. `expired`, `aborted` and `timeout`
are non-fatal — the session is gone, the button is not stuck, the committed text
stays. `auth_expired` is retryable by minting a new token. Treat
`unsupported` (no `getUserMedia`, no `AudioWorklet`, protobuf in a browser) as a
capability answer, not a bug.

`cancel()` owns the ending even after `stop()` was called. Cancelling while the
terminal transcript is in flight (the `committing` phase) removes the pre-edit
and discards the server's answer: it is written nowhere, and it cannot reach the
utterance that replaced it. `isActive` therefore covers `committing` as well as
capture, so a host that starts from a click cannot begin a second utterance
during the finish wait — and a host that tears down a surface when
`isActive` is false will not tear it down mid-commit.

Teardown must not end an utterance: a remounting composer detaches the button
while the dictation is still running. Ending is `cancel()`/`dispose()`'s job.

`bindButton` is one affordance, not the affordance. A host whose UI is a panel
rather than a button (pi-bridge's dictation toolbar: record, keep, discard, plus
a clock and a meter) drives the same controller through `start`/`stop`/`cancel`,
`subscribe` and `onLevel`, and renders its own controls; the phase types are
public for exactly that reason. Two host rules still apply unchanged: keep the
level off the render path, and reach `getUserMedia` inside the gesture that
starts the utterance.

## Testing a host

`@earendil-works/pi-asr/testing` ships the doubles, because the alternative is a host that
reimplements the wire to avoid a socket:

```ts
import { Dictation } from '@earendil-works/pi-asr/dictation'
import { FakeMic, MockTransport, jsonMessage } from '@earendil-works/pi-asr/testing'
```

`MockTransport` records what the session sent and replays captured frames; `FakeMic`
delivers PCM and can end the device. Never stub the Web Audio globals for this:
phase transitions, not the audio graph, are what a host test is about.

## What this package will not do

- No React component, no rich-text editor adapters: those own their transactions.
- No asset of its own beyond the worklet module, and no `dist/` path anywhere in
  its source — a consumer's layout is not ours to name.
- No credential storage, no logging, no DOM beyond the adapter entry.

## Gates that keep this file true

At the repository root, `npm run check` runs biome, the dependency-declaration
gates, the entry-graph budgets (`scripts/check-entry-graphs.mjs` — each entry's
value-import closure), the asset-path gate (`scripts/check-asr-assets.mjs` —
module URLs resolve beside their source, no `dist/` paths), the browser-bundle
smoke (`scripts/check-browser-smoke.mjs` — the `./browser` graph bundles for a
platform browser with no `node:` builtins or credential code), and
`tsc --noEmit`. The package's own `npm run typecheck` adds
`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.

There is no gate on the published `dist/` artifact itself: building and
type-checking the source graph is the contract, and the browser entry's
zero-runtime-dependency closure is what a consumer installs.
