// Mint a SAMI token. Requires the IME app's access key, so it only belongs here
// (Node), never in a page or a committed file.
//
//   DOUBAO_ACCESS_KEY=... node mint.mjs
const accessKey = process.env.DOUBAO_ACCESS_KEY
if (accessKey === undefined || accessKey.length === 0) {
  console.error('mint: set DOUBAO_ACCESS_KEY to the IME app access key')
  process.exit(1)
}

const res = await fetch('https://ime.oceancloudapi.com/api/v1/user/get_config', {
  method: 'POST',
  headers: {
    'User-Agent': 'DoubaoIme/1.0.0',
    'Content-Type': 'application/json',
    'X-Api-Access-Key': accessKey,
    'X-Api-Request-Id': crypto.randomUUID(),
  },
  body: JSON.stringify({ sami_app_key: 'OrnqKvSSrs' }),
})
const j = await res.json()
console.log(j.Data?.sami_token ?? 'FAIL ' + JSON.stringify(j).slice(0, 200))
