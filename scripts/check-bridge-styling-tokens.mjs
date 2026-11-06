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
//   - A cascade layer's priority is fixed by the first appearance of its name
//     in the *bundled* stylesheet, so a shared spec's rules cannot declare
//     their own priority late: the `control` layer's order statement must sit
//     in every file that opens that layer, ahead of its first rule. Declaring
//     it once in app/index.css is not enough — `composes` inlines
//     render/buttons.module.css into module CSS that reaches the CSS chunk
//     first, which registered `control` ahead of preflight and silently gave
//     `button { color: inherit; background-color: transparent }` priority over
//     the ghost control (no ink, no hover fill).
//
//   - A boundary on a control is a different token from a hairline between
//     surfaces. `--color-border` (1.47:1 on the page) separates panels; a rule
//     that composes the ghost control and draws a border is defining the
//     control's own extent, which WCAG 1.4.11 requires at 3:1, so it must use
//     `--color-border-control`. That keeps `--color-border` to one job and keeps
//     the outlined tier honest.
//
//   - A control in a row does not float. `composes: ghost` rules may not carry
//     `--shadow-*` other than `--shadow-chip` (the floating control's edge);
//     any other elevation says the control is above the surface it sits in.
//
//   - The control's ink belongs to the tier. A rule that composes the tier may
//     not restate the tier's own rest ink (`--color-secondary`) or the meta ink
//     (`--color-muted-foreground`) as a plain `color`, nor `inherit` it: host
//     declarations are unlayered, so they outrank the layered `.ghost:hover` and
//     the ink stops moving while the fill keeps reporting state. Those two inks
//     are the `dim` (icon) and `quiet` (verb) variants in
//     render/buttons.module.css. A hue the tier cannot know (the error hue, a
//     value at --color-foreground) is exempt: there the ink is the signal.
//
//   - `anchor()` takes one of a closed set of anchor sides. `anchor(inline-start)`
//     is not in it, so the declaration is dropped and the surface keeps its
//     static inline position while its block offset stays anchored — a menu that
//     opens in the right column, at the wrong place.
//
//   - An anchored panel sits above its host in both themes. Its tone is
//     `--color-popover-bg`, which must alias `--color-surface-raised`.
//     `--color-card` is the chrome role and its direction flips between themes
//     (light: recessed below the page, dark: raised above it), so a floating
//     surface that inherited it is recessed in one theme by construction — and
//     the raised tier itself must stay lighter than the page, or "elevated"
//     stops meaning anything.
//
//   - The elevated portal panel is one spec. A `position: fixed` panel carrying
//     `--shadow-2` is declared in render/Popover.module.css and nowhere else;
//     the two full-surface variants (render/Dialog, viewer/Viewer) and the
//     model picker (the last rect-anchored panel) are named exceptions. Without
//     this, each new popover re-derived the backdrop, the chrome, and its own
//     flip/clamp arithmetic — four copies of a rule whose only difference was
//     the pigment.
//
//   - The shell coordinates are consumed by name, not restated as numbers. The
//     frame has one action column, one TopBar-band control box, and one header
//     box per pane; the table below names the rules that must take those values
//     from the token. This is the rule that was missing when the same
//     x-coordinate was derived five ways and the corner controls drifted between
//     states — prose described the alignment, and five copies of the arithmetic
//     disagreed with it.
//
//   - Type comes from the one `--fs-*` scale, and a documented role keeps the step
//     it was decided at. Type was the last styling dimension with no gate: the
//     model picker's rows sat at `--fs-md` while the shared menu's sat at
//     `--fs-sm` and the doc called "dropdowns" `--fs-lg`, so one role had three
//     sizes and only a hand audit found it. A `font-size` is a scale token (or
//     `inherit`, or a relative `em` inside a Markdown host), and the table in
//     pass 1g pins the steps the Typography section names.
//
//   - The monospace face is an allowlist. It means "machine text" (code,
//     terminal I/O, a path or URL, a git ref or status letter), and it stops
//     meaning that the moment a count or a sentence borrows it — the changes
//     badge's number, the thinking row's label, and the error line's English all
//     did. Pass 1h holds every mono rule to `MONO_SITES`, which is also how a new
//     one has to say what in that surface is machine text.
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

// The one legal order, and the canonical statement text. `control` sits between
// `components` and `utilities`; see the header for why every carrier repeats it.
const LAYER_ORDER = "theme, base, components, control, utilities";
const LAYER_STATEMENT = `@layer ${LAYER_ORDER};`;
const LAYER_BLOCK = /@layer\s+control\s*\{/;

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
const css = new Map(); // file -> comment-stripped source, for whole-file rules
const references = []; // {name, loc}

for (const f of files) {
	const isCss = f.endsWith(".css");
	const isTsLike = f.endsWith(".ts") || f.endsWith(".tsx");
	const source = readFileSync(f, "utf-8");
	if (isCss) css.set(f, strippedLines(source, false).join("\n"));
	const lines = strippedLines(source, isTsLike);

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;
		const loc = `${f}:${i + 1}`;

		// Definitions: CSS declarations, and dynamic custom-property keys set
		// from .tsx inline styles (`["--gutter-width" as string]: …`).
		if (isCss) {
			if (LAYER_BLOCK.test(line) && !css.get(f)?.includes(LAYER_STATEMENT)) {
				errors.push(
					`${loc}: opens the \`control\` layer without declaring the order — add "${LAYER_STATEMENT}" above the first rule in this file, or \`control\` may be registered before preflight`,
				);
			}
			const order = /@layer\s+([a-z]+(?:,\s*[a-z]+)+)\s*;/.exec(line);
			if (order && order[1].replace(/\s+/g, " ").trim() !== LAYER_ORDER) {
				errors.push(`${loc}: cascade layer order "${order[1]}" — the one legal order is ${LAYER_ORDER}`);
			}
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

// ── Pass 1b: a control's boundary and elevation are not a hairline's ────────

const GHOST_COMPOSES = /composes:\s*[^;]*buttons\.module\.css/;
const BORDER_DECL = /(?:^|;|\s)border(?:-color)?\s*:\s*([^;]+);/;

// The control's ink belongs to the tier, not to the host: `composes` inlines the
// tier's rules into the `control` layer, so a host declaration (unlayered, and
// therefore higher priority whatever the specificity) outranks `.ghost:hover`.
// A host that restates the rest ink as a plain `color` therefore freezes the ink
// step and leaves only the fill moving — the fill then reports a state the ink
// has stopped describing, which is what put a hover rectangle over the
// unmoving `Projects` label. The tier's own rest ink and the meta ink have
// variants (`.dim` for icon controls, `.quiet` for verbs); `color: inherit` is
// the same bug spelled as inheritance. A hue the tier cannot know (the error
// hue, a value at --color-foreground) stays legal: there the ink is the signal
// and it has no step left to take.
const TIER_OWNED_INK = /(?:^|;|\s)color\s*:\s*(?:var\(--color-(?:secondary|muted-foreground)\)|inherit)\s*;/;
const TIER_FILE = "render/buttons.module.css";

for (const [f, source] of css) {
	for (const block of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const body = block[2];
		if (!GHOST_COMPOSES.test(body)) continue;
		const loc = `${f}: ${block[1].trim().split("\n").pop()?.trim() ?? ""}`;

		if (!f.replace(/\\/g, "/").endsWith(TIER_FILE) && TIER_OWNED_INK.test(body)) {
			errors.push(
				`${loc}: control restates the tier's own ink as \`${TIER_OWNED_INK.exec(body)[0].replace(/^[;\s]+|;$/g, "")}\` — a host declaration outranks the layered tier hover, so the ink stops moving and only the fill reports the state; compose \`dim\` (icon control) or \`quiet\` (verb) from ${TIER_FILE} instead`,
			);
		}

		const border = BORDER_DECL.exec(body);
		if (border && /var\(--color-border\)/.test(border[1])) {
			errors.push(
				`${loc}: control border uses the surface hairline --color-border (1.47:1) — a control's boundary must clear 3:1, so use --color-border-control`,
			);
		}

		for (const shadow of body.matchAll(/box-shadow\s*:\s*([^;]+);/g)) {
			const value = shadow[1];
			if (/var\(--shadow-/.test(value) && !/var\(--shadow-chip\)/.test(value)) {
				errors.push(
					`${loc}: control in a row carries ${value.trim()} — only a floating control takes an edge, and it is --shadow-chip`,
				);
			}
		}
	}
}

// ── Pass 1c: shell coordinates come from their names ───────────────────────

// The frame's relationships. Each row says: this declaration must take its
// value from one of these tokens, because the number is a coordinate several
// surfaces share. Adding a row is how a new shared coordinate becomes binding
// instead of folklore.
const COORDINATES = [
	["features/sidebar/Sidebar.module.css", ".overlayHeader", "padding", ["--topbar-pad-y", "--topbar-pad-x"]],
	["features/sidebar/Sidebar.module.css", ".overlayHeader .sidebarAddBtn", "width", ["--control-box"]],
	["features/sidebar/Sidebar.module.css", ".overlayHeader .sidebarAddBtn", "height", ["--control-box"]],
	["features/sidebar/Sidebar.module.css", ".sidebarList", "padding", ["--pane-inset"]],
	["features/sidebar/Sidebar.module.css", ".sidebarFolderRowGroup", "padding-right", ["--action-gap"]],
	["features/sidebar/Sidebar.module.css", ".sidebarFolderNewBtn", "width", ["--control-box-xs"]],
	["features/sidebar/Sidebar.module.css", ".sidebarFolderNewBtn", "height", ["--control-box-xs"]],
	["features/sidebar/Sidebar.module.css", ".sidebarMenuBtn", "right", ["--action-gap"]],
	["features/sidebar/Sidebar.module.css", ".sidebarMenuBtn", "width", ["--control-box-xs"]],
	["features/sidebar/Sidebar.module.css", ".sidebarMenuBtn", "height", ["--control-box-xs"]],
	["features/sidebar/Sidebar.module.css", ".sidebarItem", "padding", ["--action-col"]],
	["features/sidebar/Sidebar.module.css", ".sidebarSectionHeader", "padding", ["--action-col"]],
	["features/sidebar/Sidebar.module.css", ".sidebarAddBtn", "width", ["--control-box-sm"]],
	["features/sidebar/Sidebar.module.css", ".sidebarAddBtn", "height", ["--control-box-sm"]],
	["features/topbar/TopBar.module.css", ".topBar", "padding", ["--topbar-pad-y", "--topbar-pad-x"]],
	["features/topbar/TopBar.module.css", ".topBarBtn", "width", ["--control-box"]],
	["features/topbar/TopBar.module.css", ".topBarBtn", "height", ["--control-box"]],
	["features/topbar/TopBar.module.css", ".changesBadge", "height", ["--topbar-row"]],
	["features/history/HistoryPane.module.css", ".header", "padding", ["--action-col"]],
	["features/history/HistoryPane.module.css", ".headerPeek", "padding", ["--topbar-pad-y", "--topbar-pad-x"]],
	["features/history/HistoryPane.module.css", ".headerPeek .closeBtn", "width", ["--control-box"]],
	["features/history/HistoryPane.module.css", ".headerPeek .closeBtn", "height", ["--control-box"]],
	["features/history/HistoryPane.module.css", ".closeBtn", "width", ["--control-box-sm"]],
	["features/history/HistoryPane.module.css", ".closeBtn", "height", ["--control-box-sm"]],
];

const coordinatesSeen = new Set();
for (const [f, source] of css) {
	const file = f.replace(/\\/g, "/");
	for (const block of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const selector = (block[1].split("\n").map((s) => s.trim()).filter(Boolean).pop() ?? "").replace(/\s+/g, " ");
		const body = block[2];
		for (const [wantFile, wantSelector, prop, tokens] of COORDINATES) {
			if (!file.endsWith(`/${wantFile}`) || selector !== wantSelector) continue;
			const decl = new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+);`).exec(body);
			if (!decl) continue;
			coordinatesSeen.add(`${wantFile}|${wantSelector}|${prop}`);
			if (!tokens.some((token) => decl[1].includes(`var(${token}`))) {
				errors.push(
					`${file}: ${wantSelector} { ${prop} } restates a shell coordinate as a number — take it from ${tokens.map((t) => `var(${t})`).join(" or ")} (see app/index.css, "Shell coordinates")`,
				);
			}
		}
	}
}
for (const [wantFile, wantSelector, prop] of COORDINATES) {
	if (!coordinatesSeen.has(`${wantFile}|${wantSelector}|${prop}`)) {
		errors.push(
			`${wantFile}: coordinate row "${wantSelector} { ${prop} }" no longer exists — update COORDINATES in scripts/check-bridge-styling-tokens.mjs`,
		);
	}
}

// ── Pass 1d: anchor() takes an anchor side, and the rule names its anchor ───
//
// `<anchor-side>` is a closed set; `anchor(inline-start)` is not in it, so the
// declaration is dropped and the panel keeps its static inline position while
// its block offset stays anchored — a menu that opens in the right column but
// the wrong place, which is exactly the bug this rule was written from.

const ANCHOR_SIDES = new Set([
	"top",
	"left",
	"right",
	"bottom",
	"start",
	"end",
	"self-start",
	"self-end",
	"center",
	"inside",
	"outside",
]);

for (const [f, source] of css) {
	for (const block of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const body = block[2];
		if (!body.includes("anchor(")) continue;
		const selector = block[1].split("\n").map((line) => line.trim()).filter(Boolean).pop() ?? "";
		for (const call of body.matchAll(/anchor\(([^)]*)\)/g)) {
			const args = call[1].split(",").map((arg) => arg.trim());
			const side = args[args.length - 1];
			const named = args.length === 1 || (args.length === 2 && /^--[A-Za-z0-9-]+$/.test(args[0]));
			if (!ANCHOR_SIDES.has(side) || !named) {
				errors.push(
					`${f}: ${selector} uses anchor(${call[1]}) — the side must be one of ${[...ANCHOR_SIDES].join(", ")}; an invalid side is dropped, which leaves the inset auto and the surface at its static position`,
				);
			}
		}
	}
}

// `position-anchor` is inherited by the state variants of the same element (the
// `[data-align]` rule), so the name is checked per file rather than per rule.
for (const [f, source] of css) {
	if (!source.includes("anchor(")) continue;
	if (!/(?:^|;|\s)position-anchor\s*:/.test(source) && !/anchor\(\s*--/.test(source)) {
		errors.push(`${f}: uses anchor() but never names an anchor — add position-anchor (or pass the anchor name to anchor()) so the offsets have something to resolve against`);
	}
}

// ── Pass 1f: the elevated portal panel has one declaration site ─────────────
//
// Backdrop + fixed panel + `--shadow-2` is the popover spec, and it lived in
// four modules with a hand-written clamp or flip in each. render/Popover owns
// it now; a new anchored surface composes that component instead of restating
// the chrome. The exceptions are the two full-surface portals and the model
// picker, which still takes a trigger rect (see docs/web/design.md).

const PANEL_SITE = "render/Popover.module.css";
const PANEL_SITE_EXCEPTIONS = new Set([
	PANEL_SITE,
	"render/Dialog.module.css",
	"features/viewer/Viewer.module.css",
	"features/composer/ComposeCard.module.css",
]);

for (const [f, source] of css) {
	if (PANEL_SITE_EXCEPTIONS.has(f.slice(ROOT.length + 1))) continue;
	for (const block of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const body = block[2];
		if (!/(?:^|;|\s)position\s*:\s*fixed/.test(body)) continue;
		// The surface can also arrive by composition, so the elevation and the
		// fixed box are separate declarations on purpose.
		const elevated = body.includes("var(--shadow-2)") || /composes:\s*surface\s+from/.test(body);
		if (!elevated) continue;
		const selector = block[1].split("\n").map((line) => line.trim()).filter(Boolean).pop() ?? "";
		errors.push(
			`${f}: ${selector} is a fixed elevated panel — anchored panels compose render/Popover (and ${PANEL_SITE} owns the chrome) unless it is one of the named exceptions in PANEL_SITE_EXCEPTIONS`,
		);
	}
}

// ── Pass 1e: row states are hue-locked, one value per dimension ─────────────
//
// A row's identity (selected) and position (hover / keyboard cursor) share the
// fill channel, so they are locked to two hues: identity is the accent tint
// from --row-selected-alpha, position is --color-muted, and the selected row's
// own hover step is --row-selected-hover-alpha. Two failures are mechanical:
// a :hover rule painting the resting identity value (selected+hover collapses
// into selected, which is what this replaced), and a structural header painted
// with a row state fill (a header 1.09:1 from the hover fill reads as a hovered
// row). Semantic rows are exempt by construction: family B spends the fill on
// meaning, which is why the current-value rules here are about the tokens that
// exist, not about every accent mix.

const RETIRED_ROW_TOKEN = "--color-accent-soft";
const STRUCTURAL_HEADER = /groupHeader|GroupHeader|sectionHeader|SectionHeader/;
const ROW_STATE_FILL = /background[^;]*var\(--(?:color-muted|row-selected)/;
// A state selector (hover/focus/attribute) means the rule is a control's
// feedback rather than the header's resting surface.
const STATE_SELECTOR = /:hover|:focus|\[data-|\[aria-/;

for (const [f, source] of css) {
	for (const part of source.split("}")) {
		const open = part.indexOf("{");
		if (open === -1) continue;
		const selector = part.slice(0, open).trim();
		const body = part.slice(open + 1);
		const where = `${f}: ${selector.split("\n").pop()?.trim()}`;

		if (/:hover/.test(selector) && body.includes("var(--row-selected-alpha)")) {
			errors.push(
				`${where}: a :hover rule paints the resting identity tint — selected+hover is the same hue's next step, var(--row-selected-hover-alpha)`,
			);
		}
		if (STRUCTURAL_HEADER.test(selector) && !STATE_SELECTOR.test(selector) && ROW_STATE_FILL.test(body)) {
			errors.push(
				`${where}: a structural header paints a row state fill — headers are a hairline plus a label, never a hover/selected surface`,
			);
		}
	}

	if (source.includes(RETIRED_ROW_TOKEN)) {
		errors.push(
			`${f}: ${RETIRED_ROW_TOKEN} is retired — row identity is the accent tint at var(--row-selected-alpha), with var(--row-selected-hover-alpha) for its hover step`,
		);
	}
}

// ── Pass 1g: type comes from the one scale, and a role keeps its step ──────
//
// Type was the last styling dimension with no gate: the model picker's rows sat
// at `--fs-md` while the shared menu's rows sat at `--fs-sm` and the doc called
// "dropdowns" `--fs-lg`, so one role had three sizes and only a hand audit could
// find it. Two rules close it — a size is a scale token, and the steps the
// Typography section describes are pinned by name.

// A Markdown host's internal sizes are a ratio of its own prose (a heading is
// 1.875 of the size it inherits), so those files may state `em`; everywhere else
// a size is a token.
const RELATIVE_TYPE_FILES = ["app/index.css", "features/conversation/actions.module.css"];
const FONT_SIZE = /(?:^|;|\s)font-size\s*:\s*([^;]+);/g;

for (const [f, source] of css) {
	const file = f.replace(/\\/g, "/");
	const relativeOk = RELATIVE_TYPE_FILES.some((p) => file.endsWith(`/${p}`));
	for (const block of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const selector = (block[1].split("\n").map((s) => s.trim()).filter(Boolean).pop() ?? "").replace(/\s+/g, " ");
		for (const decl of block[2].matchAll(FONT_SIZE)) {
			const value = decl[1].trim();
			if (/^var\(--fs-[a-z]+\)$/.test(value) || value === "inherit") continue;
			if (relativeOk && /^[\d.]+em$/.test(value)) continue;
			errors.push(
				`${file}: ${selector} { font-size: ${value} } — sizes come from the --fs-* scale; relative em belongs to a Markdown host's own ratio (${RELATIVE_TYPE_FILES.join(", ")})`,
			);
		}
	}
}

// The documented roles (docs/web/design.md, "Typography"). Each row says: this
// control class takes this step, because the prose names it for that role. A
// retune that moves the control to another step has to come here and say so,
// which is what keeps the table and the prose from quietly disagreeing.
const CONTROL_TYPE = [
	["render/Dialog.module.css", ".primary", "--fs-md", "a dialog's verbs — the one worded step above the tier's --fs-xs"],
	["render/AnchoredMenu.module.css", ".itemLabel", "--fs-sm", "a menu row"],
	["render/AnchoredMenu.module.css", ".itemDetail", "--fs-xs", "a menu row's inline detail, one step below the label"],
	["features/composer/ComposeCard.module.css", ".ledgerBody", "--fs-xs", "a ledger panel's rows, on the meta step every row takes"],
	["features/composer/ComposeCard.module.css", ".composerControlRow", "--fs-xs", "the composer row's value readouts"],
	["features/composer/ComposeCard.module.css", ".portalItemSelect", "--fs-sm", "the model picker's rows, which are menu rows"],
	["features/composer/ComposeCard.module.css", ".portalSearchInput", "--fs-sm", "the picker's field: one step with the rows it filters"],
	["features/conversation/turns.module.css", ".labelSave", "--fs-xs", "a worded verb in a row"],
];

const controlTypeSeen = new Set();
for (const [f, source] of css) {
	const file = f.replace(/\\/g, "/");
	for (const block of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const selector = (block[1].split("\n").map((s) => s.trim()).filter(Boolean).pop() ?? "").replace(/\s+/g, " ");
		for (const [wantFile, wantSelector, token, role] of CONTROL_TYPE) {
			if (!file.endsWith(`/${wantFile}`) || selector !== wantSelector) continue;
			const decl = /(?:^|;|\s)font-size\s*:\s*([^;]+);/.exec(block[2]);
			if (!decl) continue;
			controlTypeSeen.add(`${wantFile}|${wantSelector}`);
			if (decl[1].trim() !== `var(${token})`) {
				errors.push(
					`${file}: ${wantSelector} { font-size: ${decl[1].trim()} } — the documented step for ${role} is var(${token}) (docs/web/design.md, "Typography"); update CONTROL_TYPE if the role moved`,
				);
			}
		}
	}
}
for (const [wantFile, wantSelector, token, role] of CONTROL_TYPE) {
	if (!controlTypeSeen.has(`${wantFile}|${wantSelector}`)) {
		errors.push(
			`${wantFile}: type row "${wantSelector} { font-size }" no longer exists — the documented step for ${role} is var(${token}); update CONTROL_TYPE in scripts/check-bridge-styling-tokens.mjs`,
		);
	}
}

// ── Pass 1h: the monospace face is machine text, and it is an allowlist ─────

// Every rule that declares the mono face, with what in that surface is machine
// text. A face is a claim about content: code, terminal I/O, a path or URL, a
// git ref, a status letter. A count, a form label, or a sentence in the same
// face makes the claim false for the whole app, so adding a use is a decision
// recorded here rather than a declaration a reviewer has to notice.
const MONO_SITES = [
	["app/index.css", "pre, code, .mono", "code — Markdown/Streamdown bodies and the manual override"],
	["app/SecureContextHint.module.css", ".rowValue", "the URL a secure-context capability depends on"],
	["render/Dialog.module.css", ".value", "the path or URL a confirmation names"],
	["features/composer/ComposeCard.module.css", ".completionItem", "the path completion offers"],
	["features/conversation/actions.module.css", ".editDiff", "the edit diff"],
	["features/conversation/actions.module.css", ".rowPreview", "the command a tool call runs"],
	["features/conversation/actions.module.css", ".cardOutput", "command output"],
	["features/conversation/actions.module.css", ".outputHint", "the elision line inside a terminal block"],
	["features/conversation/actions.module.css", ".cardHeader", "the shell command line"],
	["features/conversation/actions.module.css", ".toolEditOld", "a diff side"],
	["features/conversation/actions.module.css", ".toolEditNew", "a diff side"],
	["features/conversation/turns.module.css", ".userBashPrompt", "the user's shell prompt"],
	["features/conversation/turns.module.css", ".systemRaw", "the raw system payload as JSON"],
	["features/conversation/turns.module.css", ".errorAttrs", "error attribute values (status codes, ids)"],
	["features/conversation/turns.module.css", ".gitActionMeta", "branch and short oid"],
	["features/launcher/Launcher.module.css", ".rowCwd", "a project's working directory"],
	["features/viewer/FileBrowser.module.css", ".treeStatus", "a file's status letter"],
	["features/viewer/FileBrowser.module.css", ".fileBarPath", "the open file's path"],
	["features/viewer/FileBrowser.module.css", ".sectionPath", "a diff section's path"],
	["features/viewer/FileBrowser.module.css", ".fileNote", "the file's label and path"],
	["features/viewer/FileBrowser.module.css", ".diffLines", "the diff body"],
	["features/viewer/FileBrowser.module.css", ".stateChip", "a comparison endpoint (HEAD, Index, an oid)"],
	["features/viewer/FileBrowser.module.css", ".pickerOptionLabel", "a comparison endpoint in the picker"],
	["features/viewer/FileBrowser.module.css", ".comparePresetNote", "a preset's HEAD → Working tree range"],
	["features/viewer/Viewer.module.css", ".viewerPath", "the viewed file's path"],
	["dev/glyphs.module.css", ".name", "the dev glyph browser's export name (never built)"],
];

const monoSeen = new Set();
for (const [f, source] of css) {
	const file = f.replace(/\\/g, "/");
	for (const block of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const decl = /(?:^|;|\s)font-family\s*:\s*([^;]+);/.exec(block[2]);
		if (!decl || !/monospace/.test(decl[1])) continue;
		const selector = (block[1].split("\n").map((s) => s.trim()).filter(Boolean).pop() ?? "").replace(/\s+/g, " ");
		const row = MONO_SITES.find(([wantFile, wantSelector]) => file.endsWith(`/${wantFile}`) && selector === wantSelector);
		if (!row) {
			errors.push(
				`${file}: ${selector} declares the mono face — it is reserved for code, terminal I/O, paths/URLs, and machine tokens (git refs, status letters); if this surface is one of those, add it to MONO_SITES with the reason, otherwise it is UI stack`,
			);
			continue;
		}
		monoSeen.add(`${row[0]}|${row[1]}`);
	}
}
for (const [wantFile, wantSelector, reason] of MONO_SITES) {
	if (!monoSeen.has(`${wantFile}|${wantSelector}`)) {
		errors.push(
			`${wantFile}: mono row "${wantSelector} { font-family }" no longer exists (${reason}) — update MONO_SITES in scripts/check-bridge-styling-tokens.mjs`,
		);
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

// ── Pass 3b: the overlay surface sits above its host in both themes ─────────
//
// "Elevated" is an ordering, not a colour: an anchored panel has to read as
// floating in both themes, so its tone is the raised tier. See the header for
// why inheriting the chrome tier cannot satisfy that.

const RAISED_TIER = "--color-surface-raised";
const PAGE_TONE = "--color-background";
const POPOVER_TONE = "--color-popover-bg";

/** Relative luminance of a `#rrggbb` literal, or null when it is not one. */
function hexLuminance(value) {
	const m = /^#([0-9a-f]{6})$/i.exec(value ?? "");
	if (!m) return null;
	const channel = (offset) => {
		const c = Number.parseInt(m[1].slice(offset, offset + 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

if (themeBody && darkBody) {
	const theme = declarations(themeBody);
	const dark = declarations(darkBody);
	for (const [label, tokens] of [
		["@theme", theme],
		[DARK_MEDIA, dark],
	]) {
		const raised = hexLuminance(tokens.get(RAISED_TIER));
		const page = hexLuminance(tokens.get(PAGE_TONE));
		if (raised === null || page === null) continue;
		if (raised <= page) {
			errors.push(
				`${INDEX_CSS}: ${RAISED_TIER} (${tokens.get(RAISED_TIER)}) is not lighter than ${PAGE_TONE} (${tokens.get(PAGE_TONE)}) in ${label} — an elevated surface that is not above the page reads as recessed`,
			);
		}
	}
	if (!(theme.get(POPOVER_TONE) ?? "").includes(`var(${RAISED_TIER})`)) {
		errors.push(
			`${INDEX_CSS}: ${POPOVER_TONE} must alias var(${RAISED_TIER}) — the chrome tier's direction flips between themes, so an anchored panel that inherits it is recessed in one theme by construction`,
		);
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
