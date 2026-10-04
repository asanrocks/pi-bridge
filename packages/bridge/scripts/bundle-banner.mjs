// Banner shared by the single-file bundle and its regression test.
//
// @silvia-odwyer/photon-node is CJS and loads its wasm at import time with
// fs.readFileSync(path.join(__dirname, "photon_rs_bg.wasm")). esbuild inlines
// it into this ESM bundle, where `__dirname` does not exist and no wasm ships
// beside the bundle, so `loadPhoton()` would return null and every image read
// would report "could not be resized below the inline image size limit".
// Define `__dirname`, embed the wasm, and satisfy the read from memory.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export function readPhotonWasmBase64(requireFrom = import.meta.url) {
	const entry = createRequire(requireFrom).resolve("@silvia-odwyer/photon-node");
	return readFileSync(join(dirname(entry), "photon_rs_bg.wasm")).toString("base64");
}

export function buildBundleBanner(photonWasmBase64) {
	return [
		"#!/usr/bin/env node",
		'import * as __module from "node:module";',
		'import { fileURLToPath as __fileURLToPath } from "node:url";',
		'import { dirname as __pathDirname } from "node:path";',
		"const __dirname = __pathDirname(__fileURLToPath(import.meta.url));",
		"globalThis.require = __module.createRequire(import.meta.url);",
		`const __photonWasm = Buffer.from(${JSON.stringify(photonWasmBase64)}, "base64");`,
		'const __fs = globalThis.require("node:fs");',
		"const __readFileSync = __fs.readFileSync.bind(__fs);",
		'__fs.readFileSync = (...args) => (typeof args[0] === "string" && args[0].endsWith("photon_rs_bg.wasm") ? __photonWasm : __readFileSync(...args));',
	].join("\n");
}
