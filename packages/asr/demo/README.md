# Minimal demo: a browser talking to Doubao ASR directly

One command, one page: type into a real `<textarea>` and watch the transcript
appear while you speak.

```sh
npm run demo           # from packages/asr; builds the package and the page, then serves it
```

Open the printed URL, press **Start speaking**, talk, then **Stop and commit**.
`localhost`/`127.0.0.1` counts as a secure context, which is what `getUserMedia`
requires; a plain-HTTP page served from a LAN address will not get a microphone.

## What the server is for

Two things a page cannot do for itself:

- **Set `proto-version: v2`.** Request headers are off limits to page JS, so the
  browser always speaks the JSON wire. Same endpoint, no header, JSON envelopes.
- **Register a device.** `POST log-klink.zijieapi.com/service/2/device_register/`
  takes no credential but sends no CORS headers either. The server registers
  once per process and hands the page a `device_id`.

The `device_id` is a *shared*, non-secret identity (`docs/protocol.md` §1.4), so
no secret is involved anywhere. If you would rather use a SAMI token, mint one
with `node demo/mint-token.mjs` and start the server with `--token <value>`; the
page then authenticates with the token instead. Audio never goes through the
server in either case — it streams from the tab straight to Doubao.

## Files

| File | Responsibility |
| --- | --- |
| `server.mjs` | Static files plus `/credentials`; device self-registration, cached for the process |
| `public/index.html` | The page: a textarea, a coloured interim strip, a commit log |
| `public/app.js` | `openMicrophone` → `session.push` → `text` events → `DictationEdit` → `attachInput` |
| `mint-token.mjs` | Optional: mints a `sami_token` with `X-Api-Access-Key` for `--token` |

## What the page demonstrates

- **Commit is explicit.** Interim text is a pre-edit that gets replaced wholesale;
  the utterance becomes one durable edit (one undo group) at the terminal
  message. Pressing Stop sends `FinishTask` immediately — no trailing silence.
- **Two ways to show interim text.** The textarea is written through the SDK
  (plain text, IME-shaped events), while the coloured line above it is the page
  painting the same interim text itself. That is the escape hatch for
  colouring, overlays, or a store-owned document.
- **External edits cancel, they do not corrupt.** Typing into the field while
  speaking ends the dictation and restores nothing: the span the model owned is
  no longer trustworthy.

## For debugging

`node demo/server.mjs --port 8788 --host 127.0.0.1` overrides the listen address.
The page logs nothing by default; the session's `message` events are not printed,
but you can add a `console.log(event.type)` in `pump()` in `public/app.js`.
