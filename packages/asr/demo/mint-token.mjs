#!/usr/bin/env node
// Mints a Doubao IME SAMI token and prints it on stdout.
//
// The browser cannot do this itself: the token endpoint sends no CORS headers
// and the call needs a secret access key. Everything after this point (the
// WebSocket audio stream) runs in the browser.
//
//   node demo/mint-token.mjs            # token on stdout, metadata on stderr
//   node demo/mint-token.mjs --json     # {token, expiresAt} on stdout
//
// Env: DOUBAO_ACCESS_KEY is required; DOUBAO_APP_KEY and DOUBAO_TOKEN_URL override
// the documented defaults.

// No defaults: the access key is a real secret belonging to the IME app, not to
// this package. Falling back to a built-in one would ship it to every consumer.
const APP_KEY = process.env.DOUBAO_APP_KEY ?? 'OrnqKvSSrs'
const ACCESS_KEY = process.env.DOUBAO_ACCESS_KEY
if (ACCESS_KEY === undefined || ACCESS_KEY.length === 0) {
  console.error('mint-token: set DOUBAO_ACCESS_KEY to the IME app access key')
  process.exit(1)
}
const TOKEN_URL =
  process.env.DOUBAO_TOKEN_URL ?? 'https://ime.oceancloudapi.com/api/v1/user/get_config'

// The service issues ~24 h tokens; tuff refreshes at 5 h. Expiry here is
// advisory only — the server is the authority (code 40200001 on expiry).
const ADVISORY_TTL_MS = 5 * 60 * 60 * 1000

const res = await fetch(TOKEN_URL, {
  method: 'POST',
  headers: {
    'User-Agent': 'DoubaoIme/1.0.0',
    'Content-Type': 'application/json',
    'X-Api-Access-Key': ACCESS_KEY,
    'X-Api-Request-Id': crypto.randomUUID()
  },
  body: JSON.stringify({ sami_app_key: APP_KEY })
})

if (!res.ok) {
  console.error(`token request failed: HTTP ${res.status}`)
  process.exit(1)
}

const data = await res.json()
const token = data?.Data?.sami_token
if (data?.Code !== 0 || !token) {
  console.error(`unexpected token response: ${JSON.stringify(data).slice(0, 300)}`)
  process.exit(1)
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ token, expiresAt: Date.now() + ADVISORY_TTL_MS }))
} else {
  console.log(token)
}
console.error(
  `minted ${token.length}-char token, advisory ttl ${ADVISORY_TTL_MS / 3.6e6} h`
)
