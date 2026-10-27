# Protocol probes (reproduction tooling for `docs/protocol.md`)

The specification and its conclusions live in
[`../../docs/protocol.md`](../../docs/protocol.md). This directory only holds the
scripts that produced the measurements.

```sh
# install probe dependencies once, from the repository root
npm install

# material: any 16 kHz mono PCM recording
ffmpeg -y -i ../../test/fixtures/hello.wav -ac 1 -ar 16000 -f s16le /tmp/asr16k.pcm

# 1) mint a SAMI token (needs the real secret, so server-side only)
DOUBAO_ACCESS_KEY=... TOKEN=$(node mint.mjs)

# 2) device self-registration (no auth), writes ./creds.json
node reg.mjs

# 3) JSON envelope: CASE=J1 pcm/sami, J2 opus/sami, J3 pcm/appkey+device,
#    J4 pcm/appkey without device (should fail), J5 opus/appkey+device
CASE=J5 FRAME_MS=20 TAIL_MS=0 TOKEN=$TOKEN node json.mjs /tmp/asr16k.pcm

# 4) protobuf wire (needs request headers, so Node only)
MODE=proto FRAME_MS=20 TAIL_MS=0 CREDS=./creds.json node probe.mjs /tmp/asr16k.pcm

# 5) a real browser with WebCodecs opus
#    copy web/ and trunk16k.wav into one directory, serve it, then drive it via CDP
#    (cdp.mjs assumes chromium listens on --remote-debugging-port=9222 and the page URL contains index.html)
cp ../../test/fixtures/hello.wav web/trunk16k.wav && python3 -m http.server 8321 --bind 127.0.0.1 --directory web &
chromium --headless=new --no-sandbox --disable-gpu --remote-debugging-port=9222 \
  "http://127.0.0.1:8321/index.html?did=$(node -e "console.log(require('./creds.json').device_id)")" &
node cdp.mjs 'runTest()'
```

Common environment variables:

| Variable                                                                       | Effect                                                                                  |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `MODE=proto\|json`                                                             | Which wire format (`probe.mjs`)                                                         |
| `CASE=J1..J5`                                                                  | Auth × codec combination (`json.mjs`)                                                   |
| `FRAME_MS=20\|40\|60`                                                          | opus frame length (PCM uses 100)                                                        |
| `TAIL_MS=0..600`                                                               | Trailing silence; 0 is already enough                                                   |
| `HDRS=full\|browser` / `HDRSTYLE=header\|subprotocol\|query-bare\|query-under` | Header-smuggling experiments (`probe.mjs`)                                              |
| `IDLE_MS=10000`                                                                | How long to stay idle after `StartTask` without sending frames (pre-connect experiment) |
| `CREDS=path`                                                                   | Device credential file, defaults to `/tmp/probe-win-creds.json`                         |
| `RAW=1`                                                                        | Print every server frame verbatim                                                       |
