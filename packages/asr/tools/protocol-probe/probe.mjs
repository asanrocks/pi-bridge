// Doubao IME ASR probe: protobuf/opus vs JSON/pcm, header-gate experiments.
//
//   MODE=proto FRAME_MS=20 node probe.mjs /tmp/asr16k.pcm
//   MODE=proto HDRS=browser HDRSTYLE=subprotocol node probe.mjs ...
//
// Env: MODE=proto|json  FRAME_MS=20|40|60  TAIL_MS=0..600
//      HDRS=full|browser          (full = UA + proto-version + keepalive)
//      HDRSTYLE=header|subprotocol|query-bare|query-under
//      RAW=1 dump every server frame
import { readFileSync } from 'node:fs'
import { createEncoder } from 'libopus-wasm'

const URL_BASE = 'wss://frontier-audio-ime-ws.doubao.com/ocean/api/v1/ws'
const APP_KEY = 'OrnqKvSSrs'
const AID = 401734
const SR = 16000
const UA =
  'com.bytedance.android.doubaoime/100307013 (Linux; U; Android 16; en_US; Pixel 7 Pro; Build/BP2A.250605.031.A2; Cronet/TTNetVersion:94cf429a 2025-11-17 QuicVersion:1f89f732 2025-05-08)'

const MODE = process.env.MODE ?? 'proto'
const FRAME_MS = Number(process.env.FRAME_MS ?? 20)
const TAIL_MS = Number(process.env.TAIL_MS ?? 0)
const HDRS = process.env.HDRS ?? 'full'
const HDRSTYLE = process.env.HDRSTYLE ?? 'header'
const RAW = !!process.env.RAW

const pcm = new Int16Array(readFileSync(process.argv[2]).buffer.slice(0))
const creds = JSON.parse(readFileSync(process.env.CREDS ?? '/tmp/probe-win-creds.json', 'utf8'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const log = (...a) => console.error(`[+${String(Date.now() - t0).padStart(5)}]`, ...a)

// ── protobuf (field numbers/shape mirrored from koe-asr doubaoime.rs) ──
const varint = (n) => {
  const out = []
  let v = n
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80)
    v = Math.floor(v / 128)
  }
  out.push(v)
  return Uint8Array.from(out)
}
const ld = (field, bytes) =>
  bytes && bytes.length
    ? Buffer.concat([varint((field << 3) | 2), varint(bytes.length), Buffer.from(bytes)])
    : Buffer.alloc(0)
const str = (field, s) => ld(field, Buffer.from(s, 'utf8'))
const enumi = (field, v) => Buffer.concat([varint((field << 3) | 0), varint(v)])
const PTOKEN = process.env.PTOKEN
const req = ({ token, method, payload, audio, requestId, frameState }) =>
  Buffer.concat([
    str(2, token ?? ''),
    str(3, 'ASR'),
    str(5, method),
    str(6, payload ?? ''),
    ld(7, audio),
    str(8, requestId),
    frameState ? enumi(9, frameState) : Buffer.alloc(0),
  ])
function decodeResp(raw) {
  const buf = Buffer.from(raw.buffer ?? raw, raw.byteOffset ?? 0, raw.byteLength ?? raw.length)
  const out = {}
  let i = 0
  const rd = () => {
    let shift = 0,
      v = 0,
      b
    do {
      b = buf[i++]
      v += (b & 0x7f) << shift
      shift += 7
    } while (b & 0x80)
    return v
  }
  while (i < buf.length) {
    const key = rd(),
      field = key >> 3,
      wire = key & 7
    if (wire === 0) out[field] = rd()
    else if (wire === 2) {
      const n = rd()
      out[field] = buf.subarray(i, i + n).toString('utf8')
      i += n
    } else if (wire === 5) i += 4
    else if (wire === 1) i += 8
    else throw new Error(`wire ${wire}`)
  }
  return {
    messageType: out[4] ?? '',
    status: out[5] ?? 0,
    statusMessage: out[6] ?? '',
    resultJson: out[7] ?? '',
  }
}

// ── handshake variants ──
function wsUrl() {
  const q = process.env.NO_QUERY ? '' : `?aid=${AID}&device_id=${creds.device_id}`
  const base = MODE === 'proto' ? `${URL_BASE}${q}` : URL_BASE
  if (HDRSTYLE === 'query-bare') return `${base}${base.includes('?') ? '&' : '?'}proto-version=v2`
  if (HDRSTYLE === 'query-under') return `${base}${base.includes('?') ? '&' : '?'}proto_version=v2`
  return base
}
function wsInit() {
  const headers = { Origin: 'https://example.com' }
  const protocols = []
  if (HDRS === 'full' && HDRSTYLE === 'header') {
    headers['User-Agent'] = UA
    headers['proto-version'] = 'v2'
    headers['x-custom-keepalive'] = 'true'
  }
  if (HDRSTYLE === 'subprotocol') protocols.push('v2')
  return [{ headers, protocols }, protocols.length ? protocols : undefined]
}

let sentBytes = 0
const msgCount = { text: 0, bin: 0 }
let lastText = ''
let sessionFinishedAt = 0
let firstResultAt = 0
let firstInterimAt = 0
let finalAt = 0

function noteResults(where, payloadJson) {
  const payload = JSON.parse(payloadJson)
  const results = payload.results
  if (!results?.length) {
    if (payload.extra?.vad_start) log(`${where} vad_start`)
    return
  }
  if (!firstResultAt) firstResultAt = Date.now() - t0
  const now = Date.now() - t0
  log(`${where} results x${results.length}`)
  results.forEach((r, idx) => {
    const e = r.extra ?? {}
    log(
      `   [${idx}] len=${String(r.text?.length ?? 0).padStart(3)}` +
        ` interim=${r.is_interim} vadFin=${r.is_vad_finished}` +
        ` nonstream=${e.nonstream_result ?? '-'} seq=${e.seq_id ?? '-'}` +
        ` span=${r.start_time ?? '-'}..${r.end_time ?? '-'} sfin=${e.stream_asr_finish ?? '-'} keys=${Object.keys(e).join(',')}` +
        ` | ${(r.text ?? '').slice(0, 60)}`,
    )
  })
  const first = results[0]
  if (first?.text) {
    if (first.is_interim) firstInterimAt ||= now
    else {
      finalAt = now
      lastText = first.text
    }
  }
}

async function main() {
  const [init, protocols] = wsInit()
  const url = wsUrl()
  const ws = protocols ? new WebSocket(url, protocols, init) : new WebSocket(url, init)
  ws.binaryType = 'arraybuffer'
  const wireTag = `${MODE} frame=${FRAME_MS}ms hdrs=${HDRS} style=${HDRSTYLE}`
  log('connecting', wireTag)

  const done = new Promise((resolve) => {
    const finish = (why) => {
      log('CLOSE:', why)
      resolve()
    }
    ws.onclose = (e) => finish(`close code=${e.code} reason=${e.reason}`)
    ws.onerror = (e) => finish(`error ${e.message ?? ''}`)
    ws.onopen = () => log('open')
    ws.onmessage = (ev) => {
      const isBin = typeof ev.data !== 'string'
      msgCount[isBin ? 'bin' : 'text']++
      if (RAW) console.error('RAW', isBin ? 'bin' : 'txt', String(ev.data).slice(0, 300))
      if (isBin) {
        const resp = decodeResp(new Uint8Array(ev.data))
        log(
          `<< bin type=${resp.messageType || '-'} status=${resp.status} msg=${resp.statusMessage || '-'}`,
        )
        if (resp.messageType === 'SessionFinished') {
          sessionFinishedAt = Date.now() - t0
          return finish('SessionFinished')
        }
        if (resp.messageType.endsWith('Failed'))
          return finish(`${resp.messageType}: ${resp.statusMessage}`)
        if (resp.resultJson) noteResults('<<', resp.resultJson)
      } else {
        const msg = JSON.parse(ev.data)
        log(
          `<< txt event=${msg.event ?? '-'} status=${msg.status_code ?? '-'} ${msg.status_text ?? ''}`,
        )
        if (msg.status_code && msg.status_code !== 20000000)
          return finish(`status ${msg.status_code} ${msg.status_text}`)
        if (msg.event === 'TaskFinished') {
          sessionFinishedAt = Date.now() - t0
          return finish('TaskFinished')
        }
        if (msg.payload) noteResults('<<', msg.payload)
      }
    }
  })

  await new Promise((res, rej) => {
    ws.onopen = res
    const oe = ws.onerror
    ws.onerror = (e) => {
      oe?.(e)
      rej(new Error('open failed: ' + (e.message ?? '')))
    }
  })
  const send = (data) => {
    sentBytes += data.byteLength ?? data.length
    ws.send(data)
  }

  const requestId = crypto.randomUUID()
  const taskId = crypto.randomUUID()
  const sessionId = crypto.randomUUID()

  if (MODE === 'proto') {
    send(req({ token: PTOKEN ?? APP_KEY, method: 'StartTask', requestId }))
    await sleep(300)
    const session = JSON.stringify({
      audio_info: { channel: 1, format: 'speech_opus', sample_rate: SR },
      enable_punctuation: true,
      enable_speech_rejection: false,
      extra: {
        app_name: 'com.android.chrome',
        cell_compress_rate: 8,
        did: creds.device_id,
        enable_asr_threepass: true,
        enable_asr_twopass: true,
        input_mode: 'tool',
      },
    })
    send(req({ token: PTOKEN ?? APP_KEY, method: 'StartSession', payload: session, requestId }))
    await sleep(400)
  } else {
    send(
      JSON.stringify({
        task_id: taskId,
        session_id: sessionId,
        namespace: 'ASR',
        event: 'StartTask',
        appkey: APP_KEY,
        token: creds.token,
        payload: JSON.stringify({
          app_name: 'DoubaoIme',
          app_version: '1.0.0.207',
          enable_asr_twopass: true,
          enable_asr_threepass: true,
          strong_ddc: true,
          remove_space_between_han_num: true,
          remove_space_between_han_eng: true,
          enable_asr_format: true,
          audio_format: 'raw_pcm',
        }),
      }),
    )
    await sleep(150)
  }

  const samplesPerFrame = (SR * FRAME_MS) / 1000
  const enc =
    MODE === 'proto'
      ? await createEncoder({
          sampleRate: SR,
          channels: 1,
          frameSize: samplesPerFrame,
          bitrate: 32000,
        })
      : null
  const bytesPerFrame = samplesPerFrame * 2
  const pcmBytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const totalFrames = Math.ceil(pcmBytes.length / bytesPerFrame)
  log(`streaming ${pcmBytes.length} bytes, ${totalFrames} frames of ${FRAME_MS}ms`)

  let frameIdx = 0
  let nextAt = Date.now()
  for (let off = 0; off < pcmBytes.length; off += bytesPerFrame, frameIdx++) {
    const chunk = pcmBytes.subarray(off, off + bytesPerFrame)
    const padded = new Int16Array(samplesPerFrame)
    padded.set(new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 2)))
    if (MODE === 'proto') {
      const state = frameIdx === 0 ? 1 : 3
      send(
        req({
          method: 'TaskRequest',
          requestId,
          audio: enc.encode(padded),
          frameState: state,
          payload: JSON.stringify({ extra: {}, timestamp_ms: Date.now() }),
        }),
      )
    } else {
      send(chunk)
    }
    nextAt += FRAME_MS
    const wait = nextAt - Date.now()
    if (wait > 0) await sleep(wait)
  }
  log(`stream done at +${Date.now() - t0}ms, sent=${(sentBytes / 1024).toFixed(0)}KB`)

  // tail silence
  const tailFrames = Math.max(1, Math.round(TAIL_MS / FRAME_MS))
  for (let k = 0; k < tailFrames; k++) {
    const zero = new Int16Array(samplesPerFrame)
    if (MODE === 'proto') {
      const state = k === tailFrames - 1 ? 9 : 3
      send(
        req({
          method: 'TaskRequest',
          requestId,
          audio: enc.encode(zero),
          frameState: state,
          payload: JSON.stringify({ extra: {}, timestamp_ms: Date.now() }),
        }),
      )
    } else send(new Uint8Array(zero.buffer))
    nextAt += FRAME_MS
    const wait = nextAt - Date.now()
    if (wait > 0) await sleep(wait)
  }

  if (MODE === 'proto') {
    send(req({ token: PTOKEN ?? APP_KEY, method: 'FinishSession', requestId }))
    log('FinishSession sent')
  } else {
    send(
      JSON.stringify({
        task_id: taskId,
        session_id: sessionId,
        namespace: 'ASR',
        event: 'FinishTask',
        appkey: APP_KEY,
        token: creds.token,
      }),
    )
    log('FinishTask sent')
  }

  const guard = setTimeout(() => {
    log('guard timeout')
    try {
      ws.close()
    } catch {}
  }, 12000)
  await done
  clearTimeout(guard)

  const secs = pcmBytes.length / (SR * 2)
  const kbps = (sentBytes * 8) / secs / 1000
  console.log(
    JSON.stringify(
      {
        mode: MODE,
        frameMs: FRAME_MS,
        tailMs: TAIL_MS,
        hdrs: HDRS,
        style: HDRSTYLE,
        audioSecs: +secs.toFixed(2),
        sentBytes,
        kbps: +kbps.toFixed(1),
        msgCount,
        firstResultAt,
        firstInterimAt,
        finalAt,
        sessionFinishedAt,
        transcript: lastText,
      },
      null,
      2,
    ),
  )
  try {
    ws.close()
  } catch {}
  setTimeout(() => process.exit(0), 200)
}
main()
