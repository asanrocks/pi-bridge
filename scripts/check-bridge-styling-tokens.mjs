// Enforces the styling-token boundary for packages/bridge/web/src.
//
// Boundary (established when inline styles were consolidated into CSS
// modules — see the @theme unification commit):
//
//   - CSS custom property references (var(--...)) live EXCLUSIVELY in
//     .module.css files. .tsx/.ts files may use inline styles for DYNAMIC
//     values only (e.g. `width: `${n}%``, shiki `rootStyle`) — never token
//     references. This keeps the token-rename surface to CSS files, so a
//     rename can't silently break inline styles (the regression that
//     motivated this gate: the @theme sweep hit .module.css but missed
//     .tsx inline styles still using the old --bg-*/--text-*/--border names).
//
//   - Bare hex colors are forbidden outside @theme token definitions.
//     @theme defines `--token: #hex`; everything else must reference a
//     --color-* token or derive via color-mix() from one.
//
//   - Stale token names (renamed away from --bg-*/--text-*/etc. to --color-*,
//     and from --think-dot to --color-think) are forbidden anywhere —
//     catches missed renames during future token refactors.
//
// Comments are stripped before checking (block /* */ across lines for both
// CSS and TS; // line comments for TS) so hex/var references in doc comments
// don't false-positive — the gate checks styling, not prose.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "packages/bridge/web/src";

// Token names renamed away in the @theme unification. If you rename a
// token again, add the old name here so stragglers surface.
const STALE_TOKENS = [
	"--bg-primary", "--bg-secondary", "--bg-tertiary",
	"--text-primary", "--text-secondary", "--text-muted",
	"--border", "--accent", "--accent-hover",
	"--user-bg", "--user-border",
	"--card-bg", "--card-border",
	"--portal-bg", "--portal-border",
	"--overlay-bg",
	"--error", "--success", "--warning", "--streaming",
	"--think-dot",
];

function walk(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) out.push(...walk(p));
		else out.push(p);
	}
	return out;
}

// Strip /* */ block comments from a single line, tracking multi-line state.
// Returns { line, inComment } where `line` has comment text removed and
// `inComment` is the state to carry into the next line.
function stripBlockComment(rawLine, inComment) {
	let stripped = "";
	let i = 0;
	let state = inComment;
	while (i < rawLine.length) {
		if (state) {
			const close = rawLine.indexOf("*/", i);
			if (close === -1) {
				i = rawLine.length;
				break;
			}
			state = false;
			i = close + 2;
		} else {
			const open = rawLine.indexOf("/*", i);
			if (open === -1) {
				stripped += rawLine.slice(i);
				break;
			}
			stripped += rawLine.slice(i, open);
			state = true;
			i = open + 2;
		}
	}
	return { line: stripped, inComment: state };
}

const errors = [];

for (const f of walk(ROOT)) {
	const isCss = f.endsWith(".css");
	const isTsLike = f.endsWith(".ts") || f.endsWith(".tsx");
	if (!isCss && !isTsLike) continue;

	const src = readFileSync(f, "utf-8");
	let inBlockComment = false;
	let lineNum = 0;
	for (const rawLine of src.split("\n")) {
		lineNum++;
		const { line: afterBlock, inComment: state } = stripBlockComment(rawLine, inBlockComment);
		inBlockComment = state;
		let line = afterBlock;
		// TS/TSX: strip // line comments. Heuristic: // at line start or
		// preceded by whitespace and not part of a :// URL. Sufficient for
		// these hand-written files; doesn't attempt string-literal parsing.
		if (isTsLike) {
			const lc = line.indexOf("//");
			if (lc !== -1 && (lc === 0 || /\s/.test(line[lc - 1])) && line[lc - 1] !== ":") {
				line = line.slice(0, lc);
			}
		}
		if (!line.trim()) continue;

		const loc = `${f}:${lineNum}`;
		// .tsx/.ts: no token refs, no bare hex. (Inline styles are dynamic-only.)
		if (isTsLike) {
			if (line.includes("var(--")) {
				errors.push(`${loc}: var(--) in .tsx/.ts — tokens belong in .module.css: ${line.trim()}`);
			}
			if (/#[0-9a-fA-F]{3,6}\b/.test(line)) {
				errors.push(`${loc}: bare hex in .tsx/.ts — use a --color-* token: ${line.trim()}`);
			}
		}
		// .css: no bare hex outside @theme token definitions; no stale names.
		if (isCss) {
			// Exempt token definitions: `--something: #hex` (the @theme block).
			if (!/^\s*--[a-z-]+:\s*#/.test(line) && /#[0-9a-fA-F]{3,6}\b/.test(line)) {
				errors.push(`${loc}: bare hex outside @theme — use a --color-* token: ${line.trim()}`);
			}
			for (const stale of STALE_TOKENS) {
				if (line.includes(`var(${stale}`)) {
					errors.push(`${loc}: stale token "${stale}" — renamed to --color-*: ${line.trim()}`);
				}
			}
		}
	}
}

if (errors.length) {
	console.error("Styling token boundary violations in packages/bridge/web/src:");
	console.error("");
	console.error("Boundary: var(--*) and bare hex live in .module.css only; .tsx/.ts");
	console.error("inline styles hold dynamic values, never token refs. See the header");
	console.error("of scripts/check-bridge-styling-tokens.mjs for the full rule.");
	console.error("");
	for (const e of errors) console.error(`  ${e}`);
	process.exit(1);
}
console.log("packages/bridge/web/src: styling tokens OK");
