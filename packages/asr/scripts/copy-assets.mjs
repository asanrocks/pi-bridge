#!/usr/bin/env node
// Copy the files tsc cannot: browser modules that must ship as plain `.js`.
//
// `src/mic/worklet.js` is loaded by URL (`new URL('./worklet.js', import.meta.url)`
// in `src/mic/capture.ts`), so it has to exist beside the compiled `capture.js`
// in `dist/` under the same name. `tsc` emits only `.ts`, and a build step that
// renamed it would defeat the point: the file the browser fetches is the file
// this repository tests.
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assets = [
  // [source, destination], both relative to the package root.
  ['src/mic/worklet.js', 'dist/mic/worklet.js'],
]

for (const [source, destination] of assets) {
  const target = join(root, destination)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(join(root, source), target)
  console.log(`copied ${source} -> ${destination}`)
}
