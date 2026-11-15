// The one place build identity is read, shared by the two builds that must
// agree: the host (`bundle-single.mjs`, which stamps the packaged CLI) and the
// web bundle (`web/vite.config.ts`, which bakes the same stamp into the app).
//
// Identity is the commit plus a `-dirty` suffix: a rebuild of one tree is the
// same program, so it must not read as a different build. `version` comes from
// package.json and `date` from the commit, both for display only.
//
// `dev` produces the marker stamp (see core/build-identity.ts): the web build
// asks for it in development mode, and the host build never does — a packaged
// CLI without a real stamp would switch the client's check off silently, which
// is why `bundle-single.mjs` refuses a dev-mode web bundle outright.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEV_STAMP = { version: "0.0.0", commit: "dev", date: "1970-01-01" };

/** The stamp for a build rooted at `root` (the package directory). */
export function readBuildStamp(root, { dev = false } = {}) {
	if (dev) return { ...DEV_STAMP };

	const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
	const commit = git(root, ["rev-parse", "--short", "HEAD"]) ?? process.env.PI_BRIDGE_COMMIT ?? "unknown";
	const dirty = (git(root, ["status", "--porcelain"]) ?? "").length > 0;
	const date = git(root, ["log", "-1", "--format=%cd", "--date=short"]) ?? process.env.PI_BRIDGE_DATE ?? "unknown";

	return {
		version,
		commit: dirty && commit !== "unknown" ? `${commit}-dirty` : commit,
		date,
	};
}

/** The `src/version.ts` module text for a stamp: the four constants the CLI
 * banner reads, plus the stamp the wire reports. Written into `dist/`, so the
 * TypeScript source the checkout carries is untouched. */
export function versionModuleSource(stamp, piCore) {
	return `${[
		`export const version = ${JSON.stringify(stamp.version)};`,
		`export const commit = ${JSON.stringify(stamp.commit)};`,
		`export const date = ${JSON.stringify(stamp.date)};`,
		`export const piCore = ${JSON.stringify(piCore)};`,
		`export const buildStamp = { version, commit, date };`,
	].join("\n")}\n`;
}

function git(root, args) {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
	if (result.status !== 0) return null;
	return result.stdout.trim();
}
