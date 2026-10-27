const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'))
if (!page) {
  console.error(
    'no page',
    list.map((t) => t.type + ':' + t.url),
  )
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  } else if (m.method === 'Runtime.consoleAPICalled')
    console.error('page:', m.params.args.map((a) => a.value ?? a.description).join(' '))
  else if (m.method === 'Runtime.exceptionThrown')
    console.error('page EXC:', JSON.stringify(m.params.exceptionDetails).slice(0, 400))
}
const send = (method, params = {}) =>
  new Promise((res) => {
    const n = ++id
    pending.set(n, res)
    ws.send(JSON.stringify({ id: n, method, params }))
  })
await new Promise((r) => {
  ws.onopen = r
})
await send('Runtime.enable')
const expr = process.argv[2] ?? 'runTest()'
const r = await send('Runtime.evaluate', {
  expression: `(async()=>{ return JSON.stringify(await ${expr}) })()`,
  awaitPromise: true,
  returnByValue: true,
})
console.log(JSON.stringify(r.result?.result?.value ?? r.result, null, 2))
if (r.result?.exceptionDetails)
  console.error('EXC', JSON.stringify(r.result.exceptionDetails).slice(0, 600))
process.exit(0)
