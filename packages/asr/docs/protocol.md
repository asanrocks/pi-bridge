# Doubao IME ASR protocol notes

The **single authoritative protocol document** for this repo's L1 implementation
and its future maintenance. Every conclusion carries an evidence grade:

| Marker | Meaning                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------- |
| ✅     | Measured with a probe this round or earlier, reproducible (commands in §9)                              |
| ⚠️     | Measured, but on thin evidence (one observation / one fixed sample): a known behaviour, not a guarantee |
| ✗      | Unverified — do not assume it when implementing                                                         |

Collection environment: 2026-10-24, Node 26.12.0, system Chromium (a real page with
WebCodecs), material `trunk16k.pcm` / `trunk16k.wav` (2.26 s, "你好，我是豆包输入法。").
The server is an undocumented endpoint and may change at any time; this document
describes **the server's behaviour right now**.

---

## 0. Decisions at a glance

| Question                                | Answer                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| Can a browser stream directly?          | Yes ✅ — no audio relay, no secret of any kind                                          |
| Can a browser use protobuf?             | No ✅ (disproved; all three smuggling routes failed)                                    |
| So what should a browser use?           | JSON envelope + opus (WebCodecs) + SAMI token; `raw_pcm` as the fallback                |
| Can Node use protobuf?                  | Yes ✅ (Node ≥22's built-in `WebSocket` supports `{ headers }`)                         |
| What is the cheapest audio encoding?    | opus, on both wires ✅. **protobuf costs more traffic than JSON** (see §5.3)            |
| Is trailing silence needed?             | No ✅, 0 ms is enough (contradicts the old claim in `probe/README.md`)                  |
| Is there a "segment settled" signal?    | No ✅ (`stream_asr_finish` never appears — contradicts the old claim)                   |
| How many finals does a session produce? | Exactly one ✅ (including 30 s of continuous speech, including 3 s of internal silence) |

---

## 1. Endpoints and auth

| Endpoint                                                         | Purpose                                       | Auth                             | CORS                   |
| ---------------------------------------------------------------- | --------------------------------------------- | -------------------------------- | ---------------------- |
| `wss://frontier-audio-ime-ws.doubao.com/ocean/api/v1/ws`         | ASR audio stream                              | see §1.2                         | —                      |
| `POST https://ime.oceancloudapi.com/api/v1/user/get_config`      | Mint a SAMI token                             | `X-Api-Access-Key` (real secret) | none, `OPTIONS` 404 ✅ |
| `POST https://log-klink.zijieapi.com/service/2/device_register/` | Device self-registration (gets a `device_id`) | **none** ✅                      | none, `OPTIONS` 404 ✅ |

None of the three HTTP endpoints sends CORS headers, so a browser can **never**
obtain a credential; they can only run server-side (Node).

### 1.2 Credential matrix (all measured)

| Wire     | `token` field              | URL query                                      | Result                                                           |
| -------- | -------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| JSON     | SAMI token                 | none                                           | ✅ works (verified with both PCM and opus)                       |
| JSON     | fixed app key `OrnqKvSSrs` | `?aid=401734&device_id=<registered>`           | ✅ works                                                         |
| JSON     | fixed app key              | no `device_id`                                 | ❌ `40200001 IllegalToken`                                       |
| JSON     | fixed app key              | `device_id=1111111111111111111` (unregistered) | ❌ `40200001 IllegalToken`                                       |
| JSON     | empty                      | with `device_id`                               | ❌ `40200001`                                                    |
| protobuf | fixed app key              | `?aid=401734&device_id=<registered>`           | ✅ (koe's implementation)                                        |
| protobuf | settings token             | same as above                                  | ✅ (the win client's implementation, not re-verified this round) |

The point: `device_id` must be **really registered**, but it is not a secret;
`aid`/`device_id` are only used together with the app key. A minted SAMI token is
valid on the JSON wire only; on protobuf it must be rejected at config time
rather than at `StartSession`. Two failure shapes were measured, depending on
whether the URL carries `device_id`:

| protobuf + SAMI token              | Server replies                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| no `?aid&device_id`                | `SessionFailed 40200001` "session auth, userID or appID is empty"                                                         |
| with `?aid&device_id` (registered) | `SessionFailed 40000000` "no access right for current endpoint:ws,resourceID:original.sami.ASR, BaseResp.StatusCode:3003" |

So with a `device_id` auth gets further and then dies on resource permission —
both are `StartTask`-ok, `StartSession`-fail, and neither is recoverable.

### 1.3 SAMI token (recommended for browsers)

```
POST /api/v1/user/get_config
User-Agent: DoubaoIme/1.0.0
Content-Type: application/json
X-Api-Access-Key: <deployment access key>  ← real secret, must never reach a browser
X-Api-Request-Id: <uuid>

{"sami_app_key":"OrnqKvSSrs"}
→ {"Code":0,"Data":{"sami_token":"..."}}
```

- Minting takes **0.16–0.20 s** ✅ (3 runs).
- The server claims 24 h validity; tuff refreshes every 5 h. The response contains
  **no** expiry time ⚠️, so only the minting side can estimate one and record it
  in whatever it returns.
- The token is bound to neither IP nor device, and is reusable across connections
  and sessions ✅. Concurrency on one token is untested ✗.
- This is the default path because it allows per-user issuance, accounting, and
  revocation; the app key path is a shared identity that cannot be revoked.

### 1.4 Device self-registration (no secret, but only a shared identity)

```
POST /service/2/device_register/?device_platform=android&os=android&ssmix=a&_rticket=<ms>
  &cdid=<uuid>&channel=official&aid=401734&app_name=oime&version_code=100307013
  &version_name=1.3.7&manifest_version_code=100307013&update_version_code=100307013
  &resolution=1080*2400&dpi=420&device_type=Pixel+7+Pro&device_brand=google
  &language=zh&os_api=34&os_version=16&ac=wifi
User-Agent: com.bytedance.android.doubaoime/100307013 (...)

{"magic_tag":"ss_app_log","header":{ ... see koe-asr/src/doubaoime.rs::build_register_body ... ,"cdid":...,"openudid":...,"clientudid":...},"_gen_time":<ms>}
→ {"device_id":1853148651593467,"install_id":1853148651597563,...}
```

- **No auth at all**, takes **318 ms** ✅; a fresh `device_id` works on the app key
  path immediately ✅.
- `device_id` is a decimal number; use it as a string. `install_id` is optional.
- One `device_id` can be used by several concurrent sessions ✅ (two sessions on
  the same `device_id` at once, both correct). Quota and abuse surface unknown ✗.
- Expiry and reclamation policy unknown ✗. Registration is cheap, so re-register
  on demand.

### 1.5 Implementation constraints

- Put only `token` in the page — never `X-Api-Access-Key`, never `device_id`
  (keep one auth path so L1 does not fork).
- The token never goes into a URL, a log, or `localStorage`; L1's raw dumps must
  be redacted. In-memory caching plus `expiresAt` supplied by the server.
- Three failure modes, which must be distinct in the L1 contract (§7.2).

---

## 2. Transport

### 2.1 URL and query

- Base: `wss://frontier-audio-ime-ws.doubao.com/ocean/api/v1/ws`
- With app key auth, append: `?aid=401734&device_id=<registered device_id>`
- With SAMI token auth, **no query** ✅

### 2.2 The request header is the only wire-format switch

| Header                     | Effect                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `proto-version: v2`        | Switch to the protobuf binary wire. **Without it the server always speaks JSON** ✅ |
| `x-custom-keepalive: true` | Sent by all three existing clients; is it required? ✗ (no control run)              |
| `User-Agent`               | All clients send the official IME UA; is it required? ✗                             |

Without `proto-version`, sending a protobuf `StartTask` gets
`40100003 StartTaskExpected` ✅ (the server failed to parse it as JSON).

### 2.3 What a browser can do (three disproved routes)

A browser can set `Origin` and `Sec-WebSocket-Protocol`, but not arbitrary
request headers. All three attempts to "smuggle `proto-version`" failed ✅:

| Attempt                      | Result                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `new WebSocket(url, ['v2'])` | Handshake fails outright (`1006`); the server does not negotiate subprotocols |
| `?proto-version=v2`          | Ignored; replies `40100003 StartTaskExpected`                                 |
| `?proto_version=v2`          | Same as above                                                                 |

**Conclusion: a browser can only use the JSON envelope.** The only two ways to get
protobuf into a browser are a same-origin relay or a browser extension rewriting
headers — neither is in scope this round.

### 2.4 Node's WebSocket

Node ≥22's built-in `WebSocket` accepts `{ headers }` and can send `proto-version`
✅ (measured on Node 26; the header is visible in the upgrade request). So the Node
side runs protobuf with zero dependencies; swap in `ws` only when an agent is
needed.

### 2.5 Handshake sequence

protobuf (strictly two rounds — copy this order):

```
ws open
→ StartTask    ← TaskStarted
→ StartSession ← SessionStarted
→ TaskRequest(opus frame, frame_state=First/Middle/Last) …
→ FinishSession ← (is_interim:false final) ← SessionFinished
```

JSON (no `StartSession` step):

```
ws open
→ StartTask    ← TaskStarted
→ binary audio frames …
→ FinishTask   ← (is_interim:false final) ← TaskFinished
```

Both measured: after `StartTask` you need **not** wait for an ack before streaming
✅ (0 ms wait is also correct). But `TaskFailed` and audio arriving concurrently
remain a race you have to handle.

### 2.6 Close

The server sends `TaskFinished` / `SessionFinished` ~3 ms after the final, then
closes with `1000 bye` ✅. Do not treat the socket close itself as "the final
arrived" (§6.3).

---

## 3. Wire format A: protobuf

Same endpoint, selected by `proto-version: v2`. A hand-written varint codec is
enough — about 120 lines, no protobufjs needed.

### 3.1 `AsrRequest`

| Field | Type   | Content                                                                                                                    |
| ----- | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| 2     | string | `token`                                                                                                                    |
| 3     | string | `service_name`, always `"ASR"`                                                                                             |
| 5     | string | `method_name`: `StartTask` / `StartSession` / `TaskRequest` / `FinishSession`                                              |
| 6     | string | `payload` (JSON text; `StartSession` carries the session config, `TaskRequest` carries `{"extra":{},"timestamp_ms":<ms>}`) |
| 7     | bytes  | `audio_data` (opus packet)                                                                                                 |
| 8     | string | `request_id`, one UUID for the whole session                                                                               |
| 9     | enum   | `frame_state` (`TaskRequest` only)                                                                                         |

### 3.2 `AsrResponse`

| Field | Type   | Content                                                                                       |
| ----- | ------ | --------------------------------------------------------------------------------------------- |
| 1,2,3 | string | `request_id` / `task_id` / `service_name` — ignorable                                         |
| 4     | string | `message_type`: `TaskStarted` `SessionStarted` `TaskFailed` `SessionFailed` `SessionFinished` |
| 5     | varint | `status_code` (`20000000` = OK)                                                               |
| 6     | string | `status_message`                                                                              |
| 7     | string | `result_json` (**JSON text**, isomorphic with the JSON wire's `payload`)                      |
| 9     | varint | unknown, ignore                                                                               |

A decoder must skip unknown fields (error on an unknown wire type, skip an unknown
field number); otherwise the server adding a field breaks it.

### 3.3 `frame_state`

| Value | Meaning  |
| ----- | -------- |
| 1     | `First`  |
| 3     | `Middle` |
| 9     | `Last`   |

`Last` may only appear on the final frame; if the whole utterance is shorter than
one frame, send `First` and then an extra silence `Last` (koe's edge-case
handling).

### 3.4 Session config (`StartSession.payload`, verified-working shape)

```json
{
  "audio_info": { "channel": 1, "format": "speech_opus", "sample_rate": 16000 },
  "enable_punctuation": true,
  "enable_speech_rejection": false,
  "extra": {
    "app_name": "com.android.chrome",
    "cell_compress_rate": 8,
    "did": "<device_id>",
    "enable_asr_threepass": true,
    "enable_asr_twopass": true,
    "input_mode": "tool"
  }
}
```

`format` is `speech_opus` or `raw_pcm`, and both are verified on protobuf ✅. The
server does not understand `language` — do not send it (argued in koe's comments).

---

## 4. Wire format B: JSON envelope

### 4.1 Envelope

```json
{
  "task_id": "<uuid>",
  "session_id": "<uuid>",
  "namespace": "ASR",
  "event": "StartTask",
  "appkey": "OrnqKvSSrs",
  "token": "<sami_token or app key>",
  "payload": "<JSON text>",
  "extra": "<JSON text, TaskRequest only>"
}
```

Server replies are isomorphic plus `message_id`, `status_code`, `status_text`;
`payload` is JSON text.

### 4.2 Client events

| event         | When                   | `payload`                                          |
| ------------- | ---------------------- | -------------------------------------------------- |
| `StartTask`   | immediately on connect | session config (§4.3)                              |
| `TaskRequest` | —                      | **do not use**: audio goes in binary frames (§4.4) |
| `FinishTask`  | after the audio ends   | omitted                                            |
| `CancelTask`  | user cancels           | omitted (server behaviour unverified ✗)            |

### 4.3 Session config (verified-working shape, copy verbatim)

```json
{
  "app_name": "DoubaoIme",
  "app_version": "1.0.0.207",
  "enable_asr_twopass": true,
  "enable_asr_threepass": true,
  "strong_ddc": true,
  "remove_space_between_han_num": true,
  "remove_space_between_han_eng": true,
  "enable_asr_format": true,
  "audio_format": "raw_pcm",
  "audio_info": { "channel": 1, "format": "speech_opus", "sample_rate": 16000 }
}
```

- **For opus**: `audio_format: "speech_opus"`, and supply `audio_info` as well ✅.
- **For PCM**: `audio_format: "raw_pcm"`, `audio_info` may be omitted ✅.
- The two wires have different payload shapes — **do not normalise them**; pass
  extra fields through as an escape hatch.

### 4.4 Audio must be binary frames

- Each WebSocket **binary frame** carries one chunk of audio; `payload` carries no
  audio ✅.
- tuff base64s the PCM into `TaskRequest.payload`: the server still answers
  `TaskStarted`, heartbeats keep coming, but `results` is forever empty ✅ (that is
  its bug, not a protocol capability).
- A binary frame may also carry an opus packet ✅ (§5.2), in which case no `extra`
  is needed at all.

### 4.5 Server messages

| event          | Meaning                                       |
| -------------- | --------------------------------------------- |
| `TaskStarted`  | `StartTask` succeeded                         |
| (empty event)  | A result or a heartbeat; look at `payload`    |
| `TaskFailed`   | Failure, carrying `status_code`/`status_text` |
| `TaskFinished` | Session over (~3 ms after the final)          |

### 4.6 Heartbeats

While streaming, the server sends one
`payload = {"results":null,"extra":{"packet_number":N,"heartbeat_num":M}}` every
**200 ms** ✅. With pure silence there are **only heartbeats**, no `results` at all
✅. Heartbeats can serve as a liveness signal (§6.7).

---

## 5. Audio

### 5.1 Sample format

16 kHz, mono, s16le. Fill `sample_rate` with 16000.

### 5.2 Measured matrix: codec × frame length × wire format

| Wire     | Codec   | Frame length    | Result                                |
| -------- | ------- | --------------- | ------------------------------------- |
| protobuf | opus    | 20 / 40 / 60 ms | ✅ all three correct                  |
| protobuf | raw_pcm | 20 ms           | ✅ (20 ms blocks, correct transcript) |
| JSON     | opus    | 20 / 40 / 60 ms | ✅ all three correct                  |
| JSON     | raw_pcm | 100 ms          | ✅ (the demo's original shape)        |

The opus payload is a **bare opus packet**, no container header. Two different
encoders are accepted by the server: `libopus-wasm` (Node, Emscripten) ✅ and
Chromium WebCodecs `AudioEncoder` ✅. The encoder implementation is therefore
freely replaceable.

### 5.3 Bitrate and per-frame overhead (same 2.26 s material, opus targeted at 32 kbit/s)

| Configuration         | Bytes on the wire | Bitrate          |
| --------------------- | ----------------- | ---------------- |
| protobuf + opus 20 ms | 20 968 B          | 74.2 kbit/s      |
| protobuf + opus 40 ms | 15 267 B          | 54.1 kbit/s      |
| protobuf + opus 60 ms | 13 287 B          | 47.0 kbit/s      |
| JSON + opus 20 ms     | ~9 000 B          | 34.6–37.6 kbit/s |
| JSON + opus 60 ms     | ~9 400 B          | 33.3 kbit/s      |
| JSON + PCM 100 ms     | 92 146 B          | 326.3 kbit/s     |

Derivation: the protobuf envelope is **103 B/frame** (20 ms ⇒ 41 kbit/s) while the
audio payload is only ~42 B/frame; the JSON envelope costs **0** per frame (audio
is a bare binary frame). So **opus buys 10× (326→34), and protobuf then adds 55%
on top of opus**. "protobuf is cheaper on the wire" does not hold on this endpoint.

Re-verified on 30 s of continuous speech: JSON + opus 20 ms = 31.6 kbit/s
(116 033 B) ✅.

### 5.4 Encoder parameters

- WebCodecs: `{ codec: 'opus', sampleRate: 16000, numberOfChannels: 1, bitrate: 32000 }`;
  feeding `AudioWorklet`'s 128-sample quanta directly is fine, the encoder handles
  framing ✅.
- libopus-wasm: `createEncoder({ sampleRate: 16000, channels: 1, frameSize: 320|640|960, bitrate: 32000 })`
  (`frameSize` is a **sample count**, not milliseconds).
- Without an encoder, fall back to `raw_pcm` (no loss of function, just 256 kbit/s) ✅.

### 5.5 Finishing

- Zero-pad the last PCM block to a whole frame before encoding.
- protobuf: mark that frame `frame_state = Last`; if the utterance is shorter than
  one frame, send `First` and then a silence `Last`.
- **Trailing silence is not required** ✅: `tail = 0` was correct in 9 runs across
  both wires and 3 configurations (punctuation included). The old
  "add 300–600 ms of silence" claim in `probe/README.md` describes the vinput
  adapter's grace period, not a protocol requirement.
- `tail = 0` means something slightly different per wire, and the probes show it:
  `probe.mjs` clamps the protobuf tail to at least one frame, so the close is
  always a silent frame marked `Last` — the state, not the audio, is what closes
  the stream. `json.mjs` sends nothing after the last real frame, because that
  wire has no state to close. A client should reproduce exactly that split
  instead of appending silence to both.
- Stop → final takes about **+0.4…0.7 s** (including transporting the last audio
  block) ✅.

### 5.6 Pre-connecting (critical for first-word latency)

After `StartTask`, staying completely idle for 10 s with no audio frames does not
get the session reclaimed; streaming afterwards transcribes correctly ✅. So "open
the socket and `StartTask` on key-down, buffer the mic into a pre-roll" is safe and
free, and can hide minting (0.16–0.20 s) plus handshake (~0.2 s) inside the user's
first second of speech.

**But there is a limit**: while idle the server keeps sending a heartbeat every
200 ms, yet the task itself ends after ~20 s without audio.

| Pre-connect duration    | Result                                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 8 / 10 / 13 / 16 / 18 s | ✅ correct transcript                                                                                                   |
| 21 s                    | ⚠️ task already over: `TaskFinished` arrives right after streaming starts, the final is empty, and the audio is dropped |

So a heartbeat proves only that the connection is alive, not that the task is.
Keep pre-connect under ~15 s, and treat "an unsolicited terminal message" as
expiry (discard further audio, `expired = true`).

### 5.7 Capture-side notes

- `AudioContext({ sampleRate: 16000 })` may be ignored on Safari/iOS ✗ (not
  verified on a real device) — always keep a resampler ready.
- `echoCancellation: true` is usually a net loss for ASR (it suppresses the voice);
  `noiseSuppression` helps ⚠️ (experience, not measured this round).
- An `AudioContext` may start `suspended`; you must `resume()` in the same call
  stack as the user gesture, otherwise the entire session has no audio and no
  error.

---

## 6. Result semantics

### 6.1 The two tracks

In every `payload` that carries results, `results` is a **portal array**:

- `results[0]`: **cumulative text for the whole session** (with punctuation); it
  gets rewritten, shortened, and re-cut across segments.
- `results[1..]`: segment tracks tagged by `extra.seq_id` (no punctuation), with
  `start_time`/`end_time`; segment boundaries get retroactively redrawn and
  merged.

**Read `results[0]` only.** Concatenating the array repeats every sentence; reading
"the last element" loses punctuation.

### 6.2 Fields

| Field                                   | Location | Notes                                                                                                  |
| --------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `text`                                  | result   | That track's text                                                                                      |
| `is_interim`                            | result   | `true` = interim, may be replaced wholesale                                                            |
| `is_vad_finished`                       | result   | That segment's VAD has ended; `true` on the session-level final                                        |
| `extra.nonstream_result`                | result   | That segment is a three-pass re-transcription (replaceable wholesale, length jumps)                    |
| `extra.seq_id`                          | result   | **A label, not a sort key** (duplicates occur within a segment, and new segments may reuse old values) |
| `start_time` / `end_time`               | result   | Seconds (float); meaningful for segment tracks only                                                    |
| `extra.vad_start`                       | payload  | `true` = the server confirmed speech. Present on the JSON wire too ✅                                  |
| `extra.packet_number` / `heartbeat_num` | payload  | Heartbeat counters                                                                                     |
| `extra.client_ip`                       | payload  | The egress IP the server saw (for troubleshooting)                                                     |

### 6.3 Terminal criteria

| Wire     | Criterion                                        |
| -------- | ------------------------------------------------ |
| protobuf | `!is_interim && is_vad_finished` on `results[0]` |
| JSON     | `is_interim === false` on `results[0]`           |

A session produces **exactly one** session-level final ✅:

- two sentences with 3 s of silence in between (two VAD segments) → a single final
  at the end;
- 30 s of continuous speech → a single final at the end;
- `TaskFinished` / `SessionFinished` arrive 3 ms after that final.

⚠️ `results[1]` can, however, carry `is_interim:false` (observed once at 29.86 s of a
30 s session). That is exactly where "which track do I read" becomes fatal:
committing on "any `is_interim:false`" commits too early.

### 6.4 Retractions and shortening (L2 must support wholesale replacement)

- Interim text **gets shorter**: 120→99 and 121→119 observed in a 30 s session ✅.
- The final can be **shorter** than the last interim: the last interim of a 30 s
  session had 121 characters, the final 119 ✅.
- Cross-segment rewrites replace the whole of `results[0]`; the length can jump
  (an old probe saw 38→75 characters) ⚠️.
- Internal silence produces no paragraph separator: `results[0]` is simply
  concatenated (the `\n\n` mentioned in old notes was not reproduced this round) ⚠️.

### 6.5 Old claims that have been overturned

| Old claim (`probe/README.md`)                     | Current status                                      |
| ------------------------------------------------- | --------------------------------------------------- |
| "Neither side has tested the other's codec value" | JSON + `speech_opus` works ✅                       |
| "Add 300–600 ms of silence after stopping"        | Not needed; 0 ms is enough ✅                       |
| "`stream_asr_finish` marks the segment settled"   | **Never appeared** on either wire, in any sample ✅ |
| "protobuf is cheaper to transport"                | At 20 ms protobuf is 55% more bytes than JSON ✅    |

### 6.6 Empty results and "said nothing"

- 2 s of pure silence: no `results` (only 200 ms heartbeats), `FinishTask` ends
  normally, the final is empty text ✅.
- **Empty text is not an error**; L1 returns it as a normal outcome (the
  "nothing was detected" semantics are the caller's decision).
- `extra.vad_start` appears only when speech was really detected ✅. So "no
  `vad_start` + no results" = said nothing, while "`vad_start` + no results" =
  spoke but was rejected — that distinction is enough for UI copy with no extra
  experiment (one long-silence re-run suffices when Q3 is picked up).

### 6.7 Latency and cadence

| Metric                                      | Value                                                                                                          |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| First result carrying text                  | ~0.92–1.31 s after audio starts (the server needs ~1 s of context; independent of frame length and encoder) ✅ |
| Gap between result messages (30 s, 98 msgs) | median 171 ms, p90 1.11 s, max 1.29 s ✅                                                                       |
| Stop → final                                | +0.4…0.7 s ✅                                                                                                  |
| Heartbeat interval                          | 200 ms ✅                                                                                                      |
| Minting a token / registering a device      | 0.16–0.20 s / 0.318 s ✅                                                                                       |

The ~1 s to the first result is the server's context requirement, **not** "text
appears only after you stop talking"; after that it pushes roughly every ~170 ms,
regardless of total duration.

---

## 7. Status codes and errors

### 7.1 Known status codes

| code       | Meaning             | Handling                                                                                                 |
| ---------- | ------------------- | -------------------------------------------------------------------------------------------------------- |
| `20000000` | OK                  | —                                                                                                        |
| `40100003` | `StartTaskExpected` | Wire-format mismatch (usually the missing `proto-version` header)                                        |
| `40200001` | `IllegalToken`      | Bad credential: expired token, or a missing/unregistered `device_id` on the app key path                 |
| `40000000` | `no access right`   | The credential is valid but lacks permission for this resource (e.g. a SAMI token on protobuf, see §1.2) |

Do not swallow unknown codes; pass them through with a `retryable` hint.

### 7.2 The three auth failure shapes

| Timing                              | Recoverability               | Suggested handling                                                                      |
| ----------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------- |
| Rejected on `StartTask`             | Retry invisibly              | Reconnect with a new token; the audio is still in the pre-roll, nothing is lost         |
| Rejected mid-session                | Wind down only               | Keep the text already on screen, offer a retry; bound the attempts                      |
| Near the end of the validity period | Switch at session boundaries | Rotate before the remaining lifetime drops under a threshold, and only between sessions |

L1 expresses all three as one type instead of three APIs: `AsrError` carries
`code`, the raw `status` when the failure came back in-band, and `retryable`.
The mapping is fixed, so a caller can branch on the hint and never string-match a
message (this is the hint §7.1 asks for):

| Signal                                                   | `code`                   | `retryable` | Why                                                              |
| -------------------------------------------------------- | ------------------------ | ----------- | ---------------------------------------------------------------- |
| `40200001` IllegalToken                                  | `auth_expired`           | true        | Mint a new token and reconnect                                   |
| `40100003` StartTaskExpected                             | `protocol`               | false       | The wire format is wrong; an identical retry fails the same way  |
| `40000000` no access right                               | `server`                 | false       | The credential is valid but forbidden here (§1.2)                |
| Any other in-band status                                 | `server`                 | true        | Unrecognised: pass it through, let the caller bound the attempts |
| Task expired after ~20 s of silence (§5.6)               | `expired`                | true        | A new session is the whole remedy                                |
| Transport failure, connect/handshake/idle/finish timeout | `connection` / `timeout` | true        | Transient by construction                                        |
| Configuration the SDK rejects (§1.2, §2.3)               | `config` / `unsupported` | false       | Retrying the same configuration is pointless                     |

`finish()` returns the same object as `outcome.error`, so expiry and the finish
timeout are branchable too, not just visible as booleans.

A `*Failed` message is terminal for the session: the mid-session shape can only be
wound down, so the client ends its own event stream there instead of waiting for a
socket close. §2.6 measures that close only after `TaskFinished`/`SessionFinished`;
after `*Failed` it is unmeasured ✗, and a UI must not stay in "recording" because a
close did not come.

---

## 8. Unverified items and risks

| Item                  | Notes                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebCodecs coverage    | Verified on Chromium only ✗. `AudioEncoder` on Safari/iOS/Firefox is unknown; the PCM fallback is verified, so that is a bandwidth regression rather than a loss of function |
| Concurrency quota     | Two concurrent sessions on one `device_id` work ✅; more, or concurrent sessions on one token, ✗                                                                             |
| Long sessions         | 30 s works ✅; >2 min untested ✗                                                                                                                                             |
| `device_id` lifecycle | Expiry / reclamation / rate limiting unknown ✗                                                                                                                               |
| `CancelTask`          | Server behaviour unverified ✗                                                                                                                                                |
| protobuf + `raw_pcm`  | 20 ms blocks are verified ✅ (§5.2); 40 / 60 / 100 ms blocks are untested ✗                                                                                                  |
| Header necessity      | Whether `x-custom-keepalive` and `User-Agent` are required has no control run ✗                                                                                              |
| Server changes        | A private endpoint that has already changed twice (`message_type` semantics, the two `results` tracks). Keep raw dumps before shipping                                       |
| Close after `*Failed` | Whether the server closes the socket after `TaskFailed`/`SessionFailed` is unmeasured ✗; the client treats the message itself as terminal (§7.2)                             |

---

## 9. Reproduction

```sh
# material: any 16 kHz mono PCM recording
ffmpeg -y -i test/fixtures/hello.wav -ac 1 -ar 16000 -f s16le /tmp/asr16k.pcm

# probes live in tools/protocol-probe/ (see its README); install at the repo root
cd tools/protocol-probe
node reg.mjs                          # device self-registration -> ./creds.json
TOKEN=$(node mint.mjs)                # mint a SAMI token
CASE=J5 FRAME_MS=20 TAIL_MS=0 TOKEN=$TOKEN CREDS=./creds.json \
  node json.mjs /tmp/asr16k.pcm       # JSON + opus + appkey/device
MODE=proto FRAME_MS=20 TAIL_MS=0 CREDS=./creds.json \
  node probe.mjs /tmp/asr16k.pcm      # protobuf + opus
#   probe.mjs    protobuf, 20/40/60 ms, including header-smuggling experiments (HDRS/HDRSTYLE)
#   json.mjs     JSON envelope, CASE=J1..J5 covering sami/appkey/device/pcm/opus
#   web/ + cdp.mjs  a real Chromium with WebCodecs opus
```

The earlier probe harnesses (the koe debug harness, win-probe, vinput, tuff) were
local scratch and are not tracked.

---

## 10. L1 implementation checklist

Must do:

1. One server message = one event; surface `results[]` whole, **without merging or
   judging terminal state**.
2. Implement both codecs per the tables here; skip unknown protobuf fields, pass
   unknown JSON fields through.
3. Send audio as binary frames; opus and pcm switchable; the encoder is a seam.
4. `sendAudio` is callable before `open` and buffers internally (pre-connect +
   pre-roll).
5. Expose heartbeats, `vad_start`, and `extra` as-is so upper layers can decide
   liveness and copy.
6. Keep the terminal criterion per wire format; assume nothing about whether
   `TaskFinished`/`SessionFinished` precedes the final.
7. Make the time from "user intends to speak" to "connection ready", the first
   result, and the final observable (timestamps).
8. Split auth failures into the three shapes of §7.2.

Must not do:

1. Do not put secrets or a `device_id` in the browser, and do not try to set custom
   request headers.
2. Do not commit text based on `results[1..]` or on "any `is_interim:false`".
3. Do not depend on `stream_asr_finish`.
4. Do not make trailing silence the default (an explicit option is fine).
5. Do not normalise the session config shape of the two wires.
6. Do not put the token in a URL, a log, or persistent storage.

---

## 11. Inventory of reference documentation

| Location                                                  | Content                                                                        | Status                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `probe/README.md` (this repo, untracked)                  | Four-implementation comparison, both protocols, latency/cost measurements      | Still useful; the four claims listed in §6.5 are superseded by this document                |
| `tools/protocol-probe/` (this repo)                       | Re-runnable scripts for every experiment added here                            | Maintained in step with this document — change protocol behaviour here first                |
| `ref/koe/koe-asr/src/doubaoime.rs`                        | protobuf fields, device registration, result semantics, segment-reset fallback | **The most complete source-level reference**, well commented; the main source for §3 and §6 |
| `ref/koe/koe-asr/tests/doubaoime_debug_test.rs`           | Streaming WAV replay harness                                                   | Reusable as a regression tool                                                               |
| `ref/koe/koe-asr/src/transcript.rs`                       | Prefix/suffix overlap merging, definite/final separation                       | Reference implementation for an L2 merge policy                                             |
| `ref/koe/koe-asr/README.md`                               | Entry point and pointers only, no protocol detail                              | —                                                                                           |
| `ref/tuff/packages/tuff-voice/src/protocol/doubao-ime.ts` | JSON envelope plus apikey minting (with a 5 h cache)                           | Usable as a reference; its audio transport (base64 in payload) is a bug                     |
| `ref/doubao-ime-win/src/asr/*`                            | protobuf implementation (settings token route)                                 | Corroborates koe                                                                            |
| `ref/doubao-ime-linux/docs/voice.md`                      | Says the protocol came from an external vinput adapter                         | No protocol detail, and it explicitly calls the interface unofficial                        |
| `ref/doubao-ime-linux/docs/validation.md`                 | Verification methodology                                                       | Its "do not rely on network failure paths" trade-off is worth borrowing                     |
| `ref/koe/DESIGN.md`                                       | Product/architecture                                                           | No DoubaoIME protocol detail                                                                |

No existing document covers: browser capability boundaries, the codec × wire
matrix, terminal-state granularity, heartbeat semantics, pre-connecting, or failure
modes. That is exactly what this document adds.
