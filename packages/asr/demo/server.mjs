#!/usr/bin/env node
/**
 * Demo server: one command, one page.
 *
 *   npm run build && node demo/server.mjs
 *
 * It exists because a page cannot do two things for itself: it cannot set the
 * `proto-version` header (so it must use the JSON wire), and it cannot register
 * a device (the registration endpoint sends no CORS headers). Everything else —
 * the audio and the whole ASR stream — goes straight from the browser to Doubao.
 *
 * The device id is a *shared*, non-secret identity, so this server holds no
 * credential and needs no configuration. `--token` serves a SAMI token instead,
 * for people who already minted one with `demo/mint-token.mjs`.
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(here, '..')
const publicDir = join(here, 'public')
const distDir = join(root, 'dist')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

const port = Number(flag('--port') ?? process.env.PORT ?? 8787)
const host = flag('--host') ?? '127.0.0.1'
const token = flag('--token') ?? process.env.PI_ASR_TOKEN ?? null

/** Cached for the process lifetime: registration is cheap, but not per request. */
let registration = null

function flag(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function respond(status, body, type = 'text/plain; charset=utf-8') {
  return { status, body: Buffer.from(body), type }
}

async function serveFile(path, type) {
  return respond(200, await readFile(path), type)
}

/** Resolve under `base` only; the demo server must not serve the repository. */
function contained(base, pathname) {
  const target = resolve(base, `.${pathname}`)
  return target === base || target.startsWith(`${base}${sep}`) ? target : null
}

async function credentials() {
  if (token !== null) return { token }
  if (registration === null) {
    const { registerDevice } = await import('../dist/node.js')
    registration = await registerDevice()
  }
  return { deviceId: registration.deviceId }
}

async function route(pathname) {
  if (pathname === '/credentials') {
    try {
      return respond(200, JSON.stringify(await credentials()), MIME['.json'])
    } catch (error) {
      return respond(502, JSON.stringify({ error: `device registration failed: ${error.message}` }), MIME['.json'])
    }
  }
  if (pathname === '/' || pathname === '/index.html') {
    return serveFile(join(publicDir, 'index.html'), MIME['.html'])
  }
  if (pathname === '/app.js') {
    return serveFile(join(publicDir, 'app.js'), MIME['.js'])
  }
  if (pathname.startsWith('/dist/')) {
    const target = contained(distDir, pathname.slice('/dist'.length))
    if (target === null) return respond(403, 'Forbidden')
    return serveFile(target, MIME[extname(target)] ?? 'application/octet-stream')
  }
  return respond(404, 'Not found')
}

async function main() {
  try {
    await stat(join(distDir, 'browser.js'))
  } catch {
    console.error('demo: dist/ is missing — run `npm run build` first.')
    process.exit(1)
  }

  const server = createServer((request, response) => {
    const pathname = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/')
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end('Method not allowed')
      return
    }
    if (pathname === '/favicon.ico') {
      response.writeHead(204).end()
      return
    }
    route(pathname)
      .then((result) => {
        response.writeHead(result.status, {
          'Content-Type': result.type,
          'Cache-Control': 'no-store',
        })
        response.end(result.body)
      })
      .catch((error) => {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end(`demo: ${error.message}`)
      })
  })

  server.listen(port, host, () => {
    const address = server.address()
    const shown = typeof address === 'object' && address !== null ? address.port : port
    console.log(`demo: http://${host}:${shown}/`)
    console.log(token === null ? 'demo: auth via device self-registration' : 'demo: auth via --token')
  })
}

await main()
