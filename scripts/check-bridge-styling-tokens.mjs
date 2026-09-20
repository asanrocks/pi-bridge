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
//     Assigning a dynamic custom property from .tsx (HistoryPane's row
//     geometry, shiki's per-token colors) is the documented exception: the
//     declaration counts as a definition for the reference check below.
//
//   - Bare hex colors are forbidden outside @theme token definitions.
//     @theme defines `--token: #hex`; everything else must reference a
//     --color-* token or derive via color-mix() from one.
//
//   - Color functions (rgb/rgba/hsl/hwb/oklch/lab/lch/color) are forbidden
//     outside token declaration lines. Without this, an elevation or tint
//     could hardcode a pigment and silently ignore the theme — the way the
//     four inline `box-shadow: … rgba(0,0,0,α)` literals did until dark
//     mode needed them restated.
//
//   - Every `var(--x)` must resolve. Custom properties are not validated at
//     declaration time, so a typo'd reference (`--color-fg` vs
//     `--color-foreground`) silently becomes unset/inherit instead of
//     failing — and dark mode turns that class of bug into a visible
//     regression.
//
//   - The theme has exactly two declaration sites, both in app/index.css: the
//     `@theme` block (light) and the `@media (prefers-color-scheme: dark)`
//     block (dark). Every literal-valued theme token in @theme needs a dark
//     counterpart, and every dark declaration must exist in @theme. Aliases
//     (var() values) are exempt from the counterpart rule: they resolve
//     through what they alias, which the dark block moves.
//
//   - The OS preference is the only theme trigger and index.css is its only
//     branch site: `prefers-color-scheme` in any other sheet is an error. The
//     app has no stored theme preference, so a second trigger would mean a
//     surface that can disagree with the rest of the app.
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
const INDEX_CSS = join(ROOT, "app", "index.css");
const DARK_MEDIA = "@media (prefers-color-scheme: dark)";
// The meta in the document head is what keeps the pre-stylesheet canvas on the
// OS side instead of flashing white while index.css loads.
const INDEX_HTML = "packages/bridge/web/index.html";

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

// A custom property declaration on one line: `--name: value;`.
const DECLARATION = /^\s*(--[a-zA-Z0-9-]+)\s*:/;
// Any custom property reference: var(--name …).
const REFERENCE = /var\(\s*(--[a-zA-Z0-9-]+)/g;
// Color functions that carry a pigment rather than deriving one from a token.
const COLOR_FUNCTION = /(?:^|[^\w-])(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\(/;
// Tokens whose value is a design decision per theme (vs geometry/scale).
function isThemeToken(name) {
	return name.startsWith("--color-") || name.startsWith("--shadow-") || name === "--action-tint";
}

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

// Strip comments from a whole file and return one entry per line.
function strippedLines(src, isTsLike) {
	const out = [];
	let inBlockComment = false;
	for (const rawLine of src.split("\n")) {
		const { line: afterBlock, inComment } = stripBlockComment(rawLine, inBlockComment);
		inBlockComment = inComment;
		let line = afterBlock;
		if (isTsLike) {
			// Heuristic: // at line start or preceded by whitespace and not part
			// of a :// URL. Sufficient for these hand-written files; doesn't
			// attempt string-literal parsing.
			const lc = line.indexOf("//");
			if (lc !== -1 && (lc === 0 || /\s/.test(line[lc - 1])) && line[lc - 1] !== ":") {
				line = line.slice(0, lc);
			}
		}
		out.push(line);
	}
	return out;
}

// Extract the body of the first `prefix { … }` block, brace-balanced.
function extractBlock(css, prefix) {
	const start = css.indexOf(prefix);
	if (start === -1) return null;
	const open = css.indexOf("{", start + prefix.length);
	if (open === -1) return null;
	let depth = 0;
	for (let i = open; i < css.length; i++) {
		if (css[i] === "{") depth++;
		else if (css[i] === "}") {
			depth--;
			if (depth === 0) return css.slice(open + 1, i);
		}
	}
	return null;
}

// Declarations of a block body: name -> value (single-line values only, which
// the token block and the dark block both use).
function declarations(body) {
	const out = new Map();
	for (const m of body.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;\n]+);/g)) {
		out.set(m[1], m[2].trim());
	}
	return out;
}

const errors = [];
const files = walk(ROOT).filter((f) => f.endsWith(".css") || f.endsWith(".ts") || f.endsWith(".tsx"));

// ── Pass 1: per-line rules, and collect definitions + references ────────────

const declared = new Set();
const references = []; // {name, loc}

for (const f of files) {
	const isCss = f.endsWith(".css");
	const isTsLike = f.endsWith(".ts") || f.endsWith(".tsx");
	const lines = strippedLines(readFileSync(f, "utf-8"), isTsLike);

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;
		const loc = `${f}:${i + 1}`;

		// Definitions: CSS declarations, and dynamic custom-property keys set
		// from .tsx inline styles (`["--gutter-width" as string]: …`).
		if (isCss) {
			const decl = DECLARATION.exec(line);
			if (decl) declared.add(decl[1]);
		} else {
			for (const m of line.matchAll(/["'](--[a-zA-Z0-9-]+)["']/g)) declared.add(m[1]);
		}

		for (const m of line.matchAll(REFERENCE)) references.push({ name: m[1], loc });

		// .tsx/.ts: no token refs, no bare hex. (Inline styles are dynamic-only.)
		if (isTsLike) {
			if (line.includes("var(--")) {
				errors.push(`${loc}: var(--) in .tsx/.ts — tokens belong in .module.css: ${line.trim()}`);
			}
			if (/#[0-9a-fA-F]{3,6}\b/.test(line)) {
				errors.push(`${loc}: bare hex in .tsx/.ts — use a --color-* token: ${line.trim()}`);
			}
		}

		if (isCss) {
			const isTokenDeclaration = DECLARATION.test(line);
			// Token declaration lines are the one place a pigment may be
			// written; both the @theme block and the dark block live there.
			if (!isTokenDeclaration && /#[0-9a-fA-F]{3,6}\b/.test(line)) {
				errors.push(`${loc}: bare hex outside @theme — use a --color-* token: ${line.trim()}`);
			}
			if (!isTokenDeclaration && COLOR_FUNCTION.test(line)) {
				errors.push(
					`${loc}: color function outside a token declaration — declare the pigment in @theme or derive it with color-mix(): ${line.trim()}`,
				);
			}
			if (line.includes("prefers-color-scheme") && f !== INDEX_CSS) {
				errors.push(
					`${loc}: prefers-color-scheme outside app/index.css — the OS preference is the theme trigger and index.css is its only branch site: ${line.trim()}`,
				);
			}
			for (const stale of STALE_TOKENS) {
				if (line.includes(`var(${stale}`)) {
					errors.push(`${loc}: stale token "${stale}" — renamed to --color-*: ${line.trim()}`);
				}
			}
		}
	}
}

// ── Pass 2: every reference resolves ────────────────────────────────────────

for (const { name, loc } of references) {
	if (!declared.has(name)) {
		errors.push(`${loc}: undefined custom property ${name} — declare it in @theme (or set it from .tsx for dynamic values)`);
	}
}

// ── Pass 3: the two theme blocks stay in step ───────────────────────────────

const indexCss = readFileSync(INDEX_CSS, "utf-8");
// Parse the comment-stripped source: the header comment names both the dark
// media query and @theme, and the extractors would match those mentions first.
const indexCssCode = strippedLines(indexCss, false).join("\n");
const themeBody = extractBlock(indexCssCode, "@theme");

// The dark token block is one of the file's prefers-color-scheme media
// queries (the other gates the .codeTokens pair); identify it by content.
let darkBody = null;
for (let at = indexCssCode.indexOf(DARK_MEDIA); at !== -1; at = indexCssCode.indexOf(DARK_MEDIA, at + 1)) {
	const body = extractBlock(indexCssCode.slice(at), DARK_MEDIA);
	if (body?.includes("--color-background:")) {
		darkBody = body;
		break;
	}
}

if (!themeBody) {
	errors.push(`${INDEX_CSS}: no @theme block found`);
}
if (!darkBody) {
	errors.push(`${INDEX_CSS}: no ${DARK_MEDIA} block declaring the dark tokens found`);
}

if (themeBody && darkBody) {
	const theme = declarations(themeBody);
	const dark = declarations(darkBody);

	for (const [name, value] of theme) {
		if (isThemeToken(name) && !value.includes("var(") && !dark.has(name)) {
			errors.push(`${INDEX_CSS}: ${name} is literal-valued in @theme but has no dark counterpart in ${DARK_MEDIA}`);
		}
	}
	for (const name of dark.keys()) {
		if (!theme.has(name)) {
			errors.push(`${INDEX_CSS}: ${name} is declared in ${DARK_MEDIA} but not in @theme`);
		}
	}
}

// ── Pass 4: the document head keeps the pre-stylesheet canvas on the OS ─────

if (!readFileSync(INDEX_HTML, "utf-8").includes('name="color-scheme"')) {
	errors.push(
		`${INDEX_HTML}: no <meta name="color-scheme"> — the canvas and native widgets would flash light before index.css loads`,
	);
}

// ── Report ─────────────────────────────────────────────────────────────────

if (errors.length) {
	console.error("Styling token boundary violations in packages/bridge/web/src:");
	console.error("");
	console.error("Boundary: var(--*) and pigments live in .module.css/index.css token");
	console.error("declarations only; .tsx/.ts inline styles hold dynamic values, never");
	console.error("token refs; @theme and the dark block must cover the same token set.");
	console.error("See the header of scripts/check-bridge-styling-tokens.mjs for the rules.");
	console.error("");
	for (const e of errors) console.error(`  ${e}`);
	process.exit(1);
}
console.log("packages/bridge/web/src: styling tokens OK");
