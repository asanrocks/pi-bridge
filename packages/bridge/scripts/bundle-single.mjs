// Build step: embed built web assets + git commit into the CLI bundle,
// producing dist/pi-bridge.mjs — a single-file, standalone node runner.
//
// Strategy:
//   1. Read the git commit hash.
//   2. Read all built web assets (dist/web/) and base64-encode them.
//   3. Overwrite the compiled dist/host/embedded-assets.js and
//      dist/version.js with the real data so esbuild inlines them when
//      bundling.
//   4. Bundle the CLI entrypoint with esbuild — npm deps are inlined so
//      the .mjs is self-contained: chmod +x and run anywhere node is.

import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const webDir = join(root, "dist", "web");
const embeddedAssetsPath = join(root, "dist", "host", "embedded-assets.js");
const versionPath = join(root, "dist", "version.js");
const outFile = join(root, "dist", "pi-bridge");

// 0. Read the git commit hash
function getGitCommit() {
	const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	});
	if (result.status === 0) {
		return result.stdout.trim();
	}
	return process.env.PI_BRIDGE_COMMIT ?? "unknown";
}

const commitHash = getGitCommit();
const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

function getCommitDate() {
	const result = spawnSync("git", ["log", "-1", "--format=%cd", "--date=short"], {
		cwd: root,
		encoding: "utf8",
	});
	if (result.status === 0) return result.stdout.trim();
	return process.env.PI_BRIDGE_DATE ?? "unknown";
}

const commitDate = getCommitDate();
console.log(`version: ${packageVersion}, commit: ${commitHash}, date: ${commitDate}`);

// 1. Write the version module with the real build metadata
writeFileSync(
	versionPath,
	[
		`export const version = ${JSON.stringify(packageVersion)};`,
		`export const commit = ${JSON.stringify(commitHash)};`,
		`export const date = ${JSON.stringify(commitDate)};`,
	].join("\n") + "\n",
	"utf8",
);

// 2. Read all web assets and base64-encode them
function collectFiles(dir) {
	const result = {};
	if (!existsSync(dir)) {
		console.warn("web assets directory not found:", dir);
		return result;
	}
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			Object.assign(result, collectFiles(full));
		} else {
			const key = relative(webDir, full).replace(/\\/g, "/");
			result[key] = readFileSync(full).toString("base64");
		}
	}
	return result;
}

const assets = collectFiles(webDir);
console.log(`embedded ${Object.keys(assets).length} web assets`);

// 3. Overwrite the compiled embedded-assets.js with the real data
writeFileSync(
	embeddedAssetsPath,
	`const embeddedAssets = ${JSON.stringify(assets)};\nexport default embeddedAssets;\n`,
	"utf8",
);

// 4. Bundle the CLI entrypoint with esbuild — inline all npm deps so the
//    .mjs is self-contained. The banner sets up a global `require` for
//    packages that use dynamic require() of node builtins (cross-spawn).
await esbuild.build({
	entryPoints: [join(root, "dist", "cli.js")],
	bundle: true,
	platform: "node",
	format: "esm",
	outfile: outFile,
	external: ["node:*"],
	minify: true,
	banner: {
		js: [
			"#!/usr/bin/env node",
			'import * as __module from "node:module";',
			"globalThis.require = __module.createRequire(import.meta.url);",
		].join("\n"),
	},
	logOverride: {
		"ignored-bare-import": "silent",
	},
});

chmodSync(outFile, 0o755);
console.log("bundled ->", outFile);
