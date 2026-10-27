#!/usr/bin/env node
// Two rules about paths that a type checker cannot enforce for the ASR package.
//
// 1. A module loaded by URL must exist beside the file that names it. The URL is
//    a string, so a rename or a `.ts` source that only becomes `.js` after a
//    build breaks it silently — the kind of defect that first appears when a
//    consumer resolves the package from `src/`.
// 2. No path may name build output (`dist/`). A package that reaches into its
//    own compiled directory is describing a layout the consumer does not have.
//
// The demo is scanned with the source because it is the package's only consumer
// outside bridge and the file that proves the browser entries still compose.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = join(ROOT, "packages", "asr");
const SCANNED = [join(PACKAGE, "src"), join(PACKAGE, "demo", "src"), join(PACKAGE, "demo", "public", "index.html")];

/**
 * Two demo files may name build output, and each is the single place that does:
 * the import map (where the package entries live for a browser) and the dev
 * server's route table. Everything else in the demo goes through them.
 */
const MAY_NAME_BUILD_OUTPUT = new Set(["packages/asr/demo/public/index.html", "packages/asr/demo/server.mjs"]);

/** `new URL('./x.js', import.meta.url)` — the only legitimate way to name a sibling asset. */
const ASSET_URL = /new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g;
/** A string that addresses build output, in code or in a module specifier. */
const BUILD_OUTPUT = /(["'`])(?:\.{0,2}\/)?dist\//;
const SOURCE_FILE = /\.(?:ts|tsx|js|mjs|html)$/;

function filesUnder(path) {
	if (!statSync(path).isDirectory()) return SOURCE_FILE.test(path) ? [path] : [];
	const out = [];
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) out.push(...filesUnder(child));
		else if (SOURCE_FILE.test(entry.name)) out.push(child);
	}
	return out;
}

const failures = [];
let urls = 0;

for (const directory of SCANNED) {
	if (!existsSync(directory)) continue;
	for (const file of filesUnder(directory)) {
		const source = readFileSync(file, "utf8");
		const where = relative(ROOT, file).replaceAll("\\", "/");

		for (const match of source.matchAll(ASSET_URL)) {
			const url = match[1] ?? "";
			// Absolute URLs and other schemes are the caller's platform, not ours.
			if (!url.startsWith(".")) continue;
			urls += 1;
			const target = resolve(dirname(file), url);
			// `new URL('.', import.meta.url)` names a directory on purpose.
			const ok = url.endsWith("/") ? existsSync(target) : existsSync(target) && statSync(target).isFile();
			if (!ok) failures.push(`${where}: ${url} does not exist next to this file`);
		}

		if (!MAY_NAME_BUILD_OUTPUT.has(where)) {
			const line = source.split("\n").find((text) => BUILD_OUTPUT.test(text));
			if (line !== undefined) failures.push(`${where}: names build output: ${line.trim()}`);
		}
	}
}

if (failures.length > 0) {
	for (const failure of failures) console.error(failure);
	console.error(`\n${failures.length} path violation(s).`);
	process.exit(1);
}
console.log(`packages/asr: ${urls} module URL(s) resolve beside their source; no build-output paths.`);
