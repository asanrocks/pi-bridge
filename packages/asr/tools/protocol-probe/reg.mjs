import { randomUUID } from 'node:crypto'
const UA =
  'com.bytedance.android.doubaoime/100307013 (Linux; U; Android 16; en_US; Pixel 7 Pro; Build/BP2A.250605.031.A2; Cronet/TTNetVersion:94cf429a 2025-11-17 QuicVersion:1f89f732 2025-05-08)'
const AID = 401734,
  VC = '100307013',
  VN = '1.3.7'
const cdid = randomUUID(),
  clientudid = randomUUID()
const openudid = Array.from({ length: 8 }, () =>
  Math.floor(Math.random() * 256)
    .toString(16)
    .padStart(2, '0'),
).join('')
const params = new URLSearchParams({
  device_platform: 'android',
  os: 'android',
  ssmix: 'a',
  _rticket: String(Date.now()),
  cdid,
  channel: 'official',
  aid: String(AID),
  app_name: 'oime',
  version_code: VC,
  version_name: VN,
  manifest_version_code: VC,
  update_version_code: VC,
  resolution: '1080*2400',
  dpi: '420',
  device_type: 'Pixel 7 Pro',
  device_brand: 'google',
  language: 'zh',
  os_api: '34',
  os_version: '16',
  ac: 'wifi',
})
const body = {
  magic_tag: 'ss_app_log',
  header: {
    device_id: 0,
    install_id: 0,
    aid: AID,
    app_name: 'oime',
    version_code: 100307013,
    version_name: VN,
    manifest_version_code: 100307013,
    update_version_code: 100307013,
    channel: 'official',
    package: 'com.bytedance.android.doubaoime',
    device_platform: 'android',
    os: 'android',
    os_api: '34',
    os_version: '16',
    device_type: 'Pixel 7 Pro',
    device_brand: 'google',
    device_model: 'Pixel 7 Pro',
    resolution: '1080*2400',
    dpi: '420',
    language: 'zh',
    timezone: 8,
    access: 'wifi',
    rom: 'UP1A.231005.007',
    rom_version: 'UP1A.231005.007',
    region: 'CN',
    tz_name: 'Asia/Shanghai',
    tz_offset: 28800,
    sim_region: 'cn',
    carrier_region: 'cn',
    cpu_abi: 'arm64-v8a',
    build_serial: 'unknown',
    not_request_sender: 0,
    sig_hash: '',
    google_aid: '',
    mc: '',
    serial_number: '',
    openudid,
    clientudid,
    cdid,
  },
  _gen_time: Date.now(),
}
const t0 = Date.now()
const res = await fetch(`https://log-klink.zijieapi.com/service/2/device_register/?${params}`, {
  method: 'POST',
  headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  redirect: 'manual',
})
const txt = await res.text()
console.log('status', res.status, 'ms', Date.now() - t0)
const j = JSON.parse(txt)
console.log(
  JSON.stringify(
    { device_id: j.device_id, install_id: j.install_id, msg: j.message ?? j.msg },
    null,
    2,
  ),
)
import('node:fs').then((fs) =>
  fs.writeFileSync(
    process.env.OUT ?? './creds.json',
    JSON.stringify(
      {
        device_id: String(j.device_id),
        install_id: String(j.install_id ?? ''),
        cdid,
        openudid,
        clientudid,
        token: '',
      },
      null,
      1,
    ),
  ),
)
