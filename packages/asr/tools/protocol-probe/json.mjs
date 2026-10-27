// JSON-envelope probes: (J1) pcm baseline, (J2) opus payload, (J3) appkey-as-token.
import { readFileSync } from 'node:fs'
import { createEncoder } from 'libopus-wasm'

const URL_BASE = 'wss://frontier-audio-ime-ws.doubao.com/ocean/api/v1/ws'
const APP_KEY = 'OrnqKvSSrs'
const AID = 401734
const SR = 16000
const CASE = process.env.CASE ?? 'J1'
const FRAME_MS = Number(process.env.FRAME_MS ?? 100)

const pcm = new Int16Array(readFileSync(process.argv[2]).buffer.slice(0))
const creds = JSON.parse(readFileSync(process.env.CREDS ?? '/tmp/probe-win-creds.json', 'utf8'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const log = (...a) => console.error(`[+${String(Date.now() - t0).padStart(5)}]`, ...a)

const opus = CASE === 'J2' || CASE === 'J5'
const useAppkey = CASE === 'J3' || CASE === 'J4' || CASE === 'J5'
const withDevice = CASE === 'J3' || CASE === 'J5'
const TAIL_MS = Number(process.env.TAIL_MS ?? 600)
const NO_INFO = !!process.env.NO_INFO
const token = useAppkey ? APP_KEY : (process.env.TOKEN ?? '')

let sent = 0
let transcript = ''
let firstResultAt = 0
const msgCount = { text: 0, bin: 0 }

async function main() {
  const url = withDevice ? `${URL_BASE}?aid=${AID}&device_id=${creds.device_id}` : URL_BASE
  const ws = new WebSocket(url, { headers: { Origin: 'https://example.com' } })
  ws.binaryType = 'arraybuffer'
  log(
    'connecting',
    CASE,
    `frame=${FRAME_MS}ms`,
    opus ? 'opus' : 'pcm',
    `token=${useAppkey ? 'APP_KEY' : 'sami'}${withDevice ? '+device' : ''}`,
  )

  const done = new Promise((res) => {
    const stop = (why) => {
      log('CLOSE:', why)
      res()
    }
    ws.onclose = (e) => stop(`close code=${e.code}`)
    ws.onerror = (e) => stop(`error ${e.message ?? ''}`)
    ws.onmessage = (ev) => {
      const isBin = typeof ev.data !== 'string'
      msgCount[isBin ? 'bin' : 'text']++
      if (isBin) {
        log('<< BIN(unexpected in json mode)')
        return
      }
      const msg = JSON.parse(ev.data)
      if (process.env.DUMP) console.error('DUMP ' + String(ev.data).slice(0, 1200))
      if (msg.status_code && msg.status_code !== 20000000)
        return stop(`status ${msg.status_code} ${msg.status_text ?? ''}`)
      if (msg.event === 'TaskFinished') return stop('TaskFinished')
      if (!msg.payload) {
        log(`<< event=${msg.event ?? '-'} (no payload)`)
        return
      }
      const p = JSON.parse(msg.payload)
      if (p.extra?.vad_start) log('<< vad_start')
      const rs = p.results
      if (!rs?.length) {
        log('<< payload sans results: ' + JSON.stringify(p).slice(0, 200))
        return
      }
      firstResultAt ||= Date.now() - t0
      log(`<< results x${rs.length}`)
      if (process.env.SHOWRAW) log('RAW ' + JSON.stringify(rs[0]).slice(0, 300))
      rs.forEach((r, i) => {
        const e = r.extra ?? {}
        log(
          `   [${i}] len=${String(r.text?.length ?? 0).padStart(3)} int=${r.is_interim} vad=${r.is_vad_finished} sfin=${r.stream_asr_finish} nonstr=${e.nonstream_result ?? '-'} seq=${e.seq_id ?? '-'} span=${r.start_time}..${r.end_time} | ${(r.text ?? '').slice(0, 40)}`,
        )
      })
      if (rs[0]?.text && rs[0].is_interim === false) transcript = rs[0].text
    }
  })

  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('open failed'))
  })
  const send = (d) => {
    sent += d.byteLength ?? d.length
    ws.send(d)
  }
  const taskId = crypto.randomUUID()
  const sessionId = crypto.randomUUID()

  const payload = {
    app_name: 'DoubaoIme',
    app_version: '1.0.0.207',
    enable_asr_twopass: true,
    enable_asr_threepass: true,
    strong_ddc: true,
    remove_space_between_han_num: true,
    remove_space_between_han_eng: true,
    enable_asr_format: true,
  }
  if (opus) {
    if (!NO_INFO) payload.audio_info = { channel: 1, format: 'speech_opus', sample_rate: SR }
    payload.audio_format = 'speech_opus'
  } else {
    payload.audio_format = 'raw_pcm'
  }
  send(
    JSON.stringify({
      task_id: taskId,
      session_id: sessionId,
      namespace: 'ASR',
      event: 'StartTask',
      appkey: APP_KEY,
      token,
      payload: JSON.stringify(payload),
    }),
  )
  await sleep(Number(process.env.STARTWAIT ?? 200))

  const idle = Number(process.env.IDLE_MS ?? 0)
  if (idle) {
    log(`idle ${idle}ms with no audio frames`)
    await sleep(idle)
  }
  const samplesPerFrame = (SR * FRAME_MS) / 1000
  const bytesPerFrame = samplesPerFrame * 2
  const pcmBytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const enc = opus
    ? await createEncoder({
        sampleRate: SR,
        channels: 1,
        frameSize: samplesPerFrame,
        bitrate: 32000,
      })
    : null

  let nextAt = Date.now()
  for (let off = 0; off < pcmBytes.length; off += bytesPerFrame) {
    const chunk = pcmBytes.subarray(off, off + bytesPerFrame)
    if (opus) {
      const f = new Int16Array(samplesPerFrame)
      f.set(new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 2)))
      send(enc.encode(f))
    } else send(chunk)
    nextAt += FRAME_MS
    const w = nextAt - Date.now()
    if (w > 0) await sleep(w)
  }
  const tail = Math.max(0, Math.round(TAIL_MS / FRAME_MS))
  for (let k = 0; k < tail; k++) {
    const z = new Int16Array(samplesPerFrame)
    if (opus) send(enc.encode(z))
    else send(new Uint8Array(z.buffer))
    nextAt += FRAME_MS
    const w = nextAt - Date.now()
    if (w > 0) await sleep(w)
  }
  send(
    JSON.stringify({
      task_id: taskId,
      session_id: sessionId,
      namespace: 'ASR',
      event: 'FinishTask',
      appkey: APP_KEY,
      token,
    }),
  )
  log('FinishTask sent')

  const guard = setTimeout(() => {
    log('guard')
    try {
      ws.close()
    } catch {}
  }, 10000)
  await done
  clearTimeout(guard)
  const secs = pcmBytes.length / (SR * 2)
  console.log(
    JSON.stringify(
      {
        CASE,
        frameMs: FRAME_MS,
        opus,
        audioSecs: +secs.toFixed(2),
        sentBytes: sent,
        kbps: +((sent * 8) / secs / 1000).toFixed(1),
        msgCount,
        firstResultAt,
        transcript,
      },
      null,
      2,
    ),
  )
  try {
    ws.close()
  } catch {}
  setTimeout(() => process.exit(0), 150)
}
main()
