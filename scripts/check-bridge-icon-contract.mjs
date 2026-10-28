// Enforces the icon and control contract for packages/bridge/web/src.
//
// The rules this gate checks are prose in docs/web/design.md ("Iconography and
// control surfaces"). They were prose-only until one sweep left a `!` standing
// in for a glyph and a single hand-applied fit constant silently under-sized
// three marks — both mechanically detectable, neither caught by types.
//
// Rules:
//
//   1. One glyph set. render/icons.tsx is the only file that may contain an
//      inline `<svg>`. Feature code imports a named `<Role>Icon`. (The
//      HistoryPane graph draws its own SVG; it is a data plot, not a glyph, and
//      is exempted by path below.)
//
//   2. Nothing in the document is a font glyph. No emoji and no geometric
//      character standing in for an icon: an emoji is a colour bitmap that
//      ignores `currentColor`, a text glyph sits on the baseline so a centred
//      square box drifts, and its advance width is not its ink width. Typed
//      characters that carry data stay legal — `→` in a label, `+`/`−` in a
//      diff, git's own A/M/D status letters, and `…` as punctuation are not
//      icons and are not checked.
//
//   3. Solid ink is a closed set of two families with different slot rules.
//      Object marks sit beside Streamdown's solid copy pair, so they are filled;
//      they are legal at 12 and 14 only, because a filled symbol at 16 or 20
//      reads as a badge rather than a control. Transport solids are filled
//      because solidity is the meaning, and live at 16 inside a filled box that
//      carries the size. Slot values themselves are a TypeScript union, so this
//      table only has to hold the family rule.
//
// Keeping the table in step with icons.tsx is checked, not trusted: every name
// listed here must still be exported, and every exported `<Role>Icon` must be
// listed. That way a new glyph forces a family decision at the point it is
// added instead of drifting into an unstated third family.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = "packages/bridge/web/src";
const ICON_SET = join(ROOT, "render", "icons.tsx");

// Files allowed to draw their own SVG or to render a character that would
// otherwise be flagged. Both are documented exceptions, not oversights:
//   - HistoryPane's graph is a data plot (geometry the icon set cannot express).
//   - The tab-title activity marker is the one legal emoji: a `document.title`
//     is OS chrome no SVG can reach.
const SVG_EXEMPT = new Set([join(ROOT, "render", "icons.tsx"), join(ROOT, "features", "history", "HistoryPane.tsx")]);
const GLYPH_EXEMPT = new Set([join(ROOT, "app", "useStatusNotifications.ts"), join(ROOT, "app", "App.tsx")]);

// Families from docs/web/design.md. Slots are the legal sizes at every call
// site; a call site with no `size` renders at the default 16 slot.
const SOLID_SLOTS = {
	// Object marks: filled to match Streamdown's own solid copy pair in the same
	// row, and capped below 16 because a filled symbol at 16 or 20 reads as a
	// badge rather than a control.
	CopyIcon: [12, 14],
	// Check is the exception: the composer's dictation row renders it at 16 as
	// the row's command ("stop and insert the transcript") rather than as a mark
	// beside copy art, next to Undo, Polish, and the Record transport dot.
	CheckIcon: [12, 14, 16],
	EyeIcon: [12, 14],
	WrapIcon: [12, 14],
	MarkdownIcon: [12, 14],
	// Menu marks: made of dots, so they have no outline form to fall back to, and
	// they only ever mark a row's overflow (< 16 by the same badge argument).
	MoreIcon: [12, 14],
	// Transport solids: filled because solidity is the meaning, and 16 because
	// the filled box around them carries the size.
	RecordIcon: [16],
	ArrowUpIcon: [16],
	StopIcon: [16],
};

// Every other exported glyph is outline, and its slot follows the row rather
// than its meaning (12 meta, 14 compact rows, 16 controls, 20 chrome). Listed
// explicitly so a new export has to be classified rather than defaulted.
const OUTLINE = [
	"ChevronDownIcon",
	"ChevronUpIcon",
	"ChevronLeftIcon",
	"ChevronRightIcon",
	"CaretIcon",
	"FolderIcon",
	"FileIcon",
	"PaperclipIcon",
	"PencilIcon",
	"UndoIcon",
	"PolishIcon",
	"CloseIcon",
	"MicIcon",
	"MenuIcon",
	"GridIcon",
	"PlusIcon",
	"BranchIcon",
	"ClockIcon",
	"BrokenLinkIcon",
	"WarningIcon",
	"PinIcon",
];

const GEOMETRIC_GLYPHS = ["▾", "▸", "▶", "◀", "▴", "▵", "▿", "△", "▲", "◁", "▷", "◄", "►", "■", "□", "▪", "▫", "●", "○", "◆", "◇", "✕", "✖", "✗", "✘", "➤", "➢", "⌃", "⌄", "⏵", "⏹", "⏺"];
const EMOJI = /\p{Extended_Pictographic}/u;

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

// Strip comments so prose about glyphs does not trip the scan. Mirrors the
// heuristic in check-bridge-styling-tokens.mjs: `//` at line start or preceded
// by whitespace and not part of a `://` URL.
function codeLines(src) {
	const out = [];
	let inBlock = false;
	for (const raw of src.split("\n")) {
		let line = "";
		let i = 0;
		let state = inBlock;
		while (i < raw.length) {
			if (state) {
				const close = raw.indexOf("*/", i);
				if (close === -1) {
					i = raw.length;
					break;
				}
				state = false;
				i = close + 2;
			} else {
				const open = raw.indexOf("/*", i);
				if (open === -1) {
					line += raw.slice(i);
					break;
				}
				line += raw.slice(i, open);
				state = true;
				i = open + 2;
			}
		}
		inBlock = state;
		const lc = line.indexOf("//");
		if (lc !== -1 && (lc === 0 || /\s/.test(line[lc - 1])) && line[lc - 1] !== ":") line = line.slice(0, lc);
		out.push(line);
	}
	return out;
}

const errors = [];
const files = walk(ROOT).filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));
const iconSetSource = readFileSync(ICON_SET, "utf-8");
const exported = new Set([...iconSetSource.matchAll(/export const (\w+Icon)\b/g)].map((m) => m[1]));

for (const f of files) {
	for (const [i, line] of codeLines(readFileSync(f, "utf-8")).entries()) {
		const loc = `${f}:${i + 1}`;
		if (!line.trim()) continue;

		// ── Rule 1: one glyph set ────────────────────────────────────────
		if (line.includes("<svg") && !SVG_EXEMPT.has(f)) {
			errors.push(`${loc}: inline <svg> outside render/icons.tsx — add a named <Role>Icon there instead: ${line.trim()}`);
		}

		// ── Rule 2: no font glyphs ───────────────────────────────────────
		if (!GLYPH_EXEMPT.has(f)) {
			for (const glyph of GEOMETRIC_GLYPHS) {
				if (line.includes(glyph)) {
					errors.push(`${loc}: "${glyph}" is a font glyph standing in for an icon — use a glyph from render/icons.tsx: ${line.trim()}`);
				}
			}
			const emoji = line.match(EMOJI);
			if (emoji) {
				errors.push(`${loc}: emoji "${emoji[0]}" in the document — an emoji is a colour bitmap that ignores currentColor; use a glyph (only a document.title marker is exempt): ${line.trim()}`);
			}
		}

		// ── Rule 3: family slots ────────────────────────
		for (const [name, slots] of Object.entries(SOLID_SLOTS)) {
			if (!line.includes(`<${name}`)) continue;
			const explicit = line.match(/size=\{(\d+)\}/);
			// The default slot when a call site omits `size` is 16.
			const slot = explicit ? Number(explicit[1]) : 16;
			if (!slots.includes(slot)) {
				errors.push(
					`${loc}: <${name}> is a solid mark and may only render at slot ${slots.join("/")} (got ${slot}) — see docs/web/design.md, "Iconography and control surfaces"`,
				);
			}
		}
	}
}

// ── The lists and the icon set stay in step ─────────────────────────────

const classified = new Set([...Object.keys(SOLID_SLOTS), ...OUTLINE]);
for (const name of Object.keys(SOLID_SLOTS)) {
	if (!exported.has(name)) {
		errors.push(`${ICON_SET}: "${name}" is listed as a solid mark but is no longer exported — update SOLID_SLOTS in scripts/check-bridge-icon-contract.mjs`);
	}
}
for (const name of OUTLINE) {
	if (!exported.has(name)) {
		errors.push(`${ICON_SET}: "${name}" is listed as outline but is no longer exported — update OUTLINE in scripts/check-bridge-icon-contract.mjs`);
	}
}
for (const name of exported) {
	if (!classified.has(name)) {
		errors.push(
			`${ICON_SET}: "${name}" is exported but unclassified — add it to SOLID_SLOTS (with its legal slots) or OUTLINE in scripts/check-bridge-icon-contract.mjs, so its ink mode is a decision rather than a default`,
		);
	}
}

// ── Rule 4: every control resolves to a tier, or to a declared role ────────
//
// "One spec per role" only binds modules that opt in, so a control that never
// composes a tier is invisible to every other check — which is how six
// hand-rolled buttons survived three sweeps. Every `<button>` either resolves
// (through `composes`) to a tier in render/buttons.module.css, or its class is
// listed below with the reason it is not a control box. Same shape as the icon
// families: the decision is made at the point of use, and a stale entry fails.

const TIERS = new Set(["ghost", "outlined", "filled"]);

// class name -> why this button is not a tiered control. Global by name: a role
// is a role wherever it appears, and a name collision would be a spec bug first.
const CONTROL_ROLES = new Map(
	Object.entries({
		// Backdrops: a full-viewport hit area, not a control.
		overlay: "backdrop (click dismisses)",
		portalOverlay: "backdrop (click dismisses)",
		pickerOverlay: "backdrop (click dismisses)",
		viewerOverlay: "backdrop (click dismisses)",
		treeScrim: "backdrop (click dismisses)",
		// Containers that happen to be buttons: the whole surface is the target.
		toast: "the toast is dismissed by clicking it",
		composerBar: "the collapsed composer bar is one wide control",
		rowMain: "launcher row (navigates)",
		// List rows and menu items: a fill plus hover, not a boxed control.
		item: "menu row",
		sidebarItem: "session row",
		sidebarItemSelected: "session row (selected)",
		sidebarMenuItem: "menu row",
		sidebarMenuClose: "menu row (destructive)",
		sidebarMenuArchive: "menu row",
		sidebarFolderRow: "folder row (the fold target)",
		treeRow: "file tree row",
		pickerOption: "list row",
		comparePreset: "list row",
		completionItem: "list row",
		portalItemSelect: "list row",
		portalMore: "list row",
		supersededRow: "history row",
		gitDiffAction: "history row action",
		// Fold headers: a full-width target carrying a caret and a label.
		actionCollapsed: "fold header",
		actionGroupHeader: "action group header (sticky fold)",
		sectionToggle: "file section fold header",
		editDiffSectionTitle: "diff section fold header",
		// Chips: a label or a value with its own geometry.
		msgLabel: "label chip (a value)",
		msgLabelGhost: "label chip (the add affordance for absent data)",
		supersededBadge: "status chip",
		noticePath: "path chip (opens the file)",
		// Value controls: the words or the number are the content.
		topBarTitle: "the Session name (rename target)",
		gitStamp: "git identity chip",
		gitStampBtn: "git identity chip (menu trigger)",
		// Floating controls keep a container (see design.md), so they are not
		// ghost boxes.
		attachRemove: "floating control over an image (ring recipe)",
		jumpToBottom: "floating control over the conversation",
		// Links inside prose.
		browse: "inline link in a sentence",
	}),
);

// A button whose class comes from a variable cannot be resolved here; the files
// allowed to do that are listed, so the exemption is explicit.
const UNRESOLVED_OK = new Set(["features/viewer/MarkdownLink.tsx"]);

function parseModules() {
	const modules = new Map();
	for (const file of walk(ROOT).filter((f) => f.endsWith(".module.css"))) {
		const rules = new Map();
		for (const block of readFileSync(file, "utf-8").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
			const selector = block[1]
				.split("\n")
				.map((s) => s.trim())
				.filter(Boolean)
				.pop();
			const name = selector === undefined ? null : /^\.([A-Za-z0-9_-]+)$/.exec(selector)?.[1];
			if (!name) continue;
			const composes = /composes\s*:\s*([^;]+);/.exec(block[2]);
			if (!composes) continue;
			const value = composes[1].trim();
			rules.set(name, {
				names: value.split(" from ")[0].trim().split(/\s+/),
				from: /from\s+["']([^"']+)["']/.exec(value)?.[1],
			});
		}
		modules.set(file, rules);
	}
	return modules;
}

const MODULES = parseModules();

/** The value of a `className` attribute, brace-balanced so a template literal's
 * `${…}` does not truncate it (a partial capture would silently drop the second
 * class, and with it that class's role). */
function classNameExpression(tag) {
	const at = tag.indexOf("className=");
	if (at < 0) return "";
	const rest = tag.slice(at + "className=".length);
	const quote = rest[0];
	if (quote === '"' || quote === "'") return rest.slice(1, rest.indexOf(quote, 1));
	let depth = 0;
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] === "{") depth++;
		else if (rest[i] === "}") {
			depth--;
			if (depth === 0) return rest.slice(1, i);
		}
	}
	return rest;
}

function resolvesToTier(file, name, seen = new Set()) {
	const key = `${file}:${name}`;
	if (seen.has(key)) return false;
	seen.add(key);
	if (file.endsWith("buttons.module.css") && TIERS.has(name)) return true;
	const rule = MODULES.get(file)?.get(name);
	if (!rule) return false;
	const next = rule.from === undefined ? file : join(file, "..", rule.from);
	return rule.names.some((composed) => resolvesToTier(next, composed, seen));
}

const rolesUsed = new Set();
for (const file of files.filter((f) => f.endsWith(".tsx"))) {
	// Comments are stripped: the transcript's own prose mentions `<button>`.
	const source = codeLines(readFileSync(file, "utf-8")).join("\n");
	const imports = new Map();
	for (const m of source.matchAll(/import\s+(\w+)\s+from\s+["']([^"']+\.module\.css)["']/g)) {
		imports.set(m[1], join(file, "..", m[2]));
	}
	for (const tag of source.matchAll(/<button\b[^>]*>/g)) {
		const idents = [...classNameExpression(tag[0]).matchAll(/(\w+)\.(\w+)/g)].map((m) => [m[1], m[2]]);
		const file_ = relative(ROOT, file).replace(/\\/g, "/");
		if (idents.length === 0) {
			if (!UNRESOLVED_OK.has(file_)) {
				errors.push(`${file}: <button> has no resolvable tier class — compose ghost/outlined/filled or list the file in UNRESOLVED_OK`);
			}
			continue;
		}
		const local = idents.filter(([variable]) => imports.has(variable));
		const tiered = local.some(([variable, name]) => resolvesToTier(imports.get(variable), name));
		if (tiered) continue;
		// A state modifier (`…Selected`, `…Focused`, a hue) rides alongside the
		// role class, so one recognised role is enough.
		const roles = local.filter(([, name]) => CONTROL_ROLES.has(name));
		if (roles.length > 0) {
			for (const [, name] of roles) rolesUsed.add(name);
			continue;
		}
		errors.push(
			`${file}: <button className={…${local.map(([, name]) => `.${name}`).join(", ")}}> composes no tier (ghost/outlined/filled) and is not in CONTROL_ROLES — either make it a tiered control or record the role it plays instead`,
		);
	}
}

// The role table describes this app's surfaces, so its anti-rot check only
// means something against the real tree: the unit tests build a fixture holding
// just the glyph set, where no feature module exists to use a role.
const scannedFeatureModules = [...MODULES.keys()].some((f) => f.replace(/\\/g, "/").endsWith("features/sidebar/Sidebar.module.css"));

for (const name of scannedFeatureModules ? CONTROL_ROLES.keys() : []) {
	if (!rolesUsed.has(name)) {
		errors.push(
			`${ROOT}: CONTROL_ROLES lists ".${name}" but no button uses it — update CONTROL_ROLES in scripts/check-bridge-icon-contract.mjs so the role table cannot rot`,
		);
	}
}

if (errors.length) {
	console.error(`Icon and control contract violations in ${ROOT}:`);
	console.error("");
	console.error("Contract: render/icons.tsx is the one glyph set, nothing in the document");
	console.error("is a font glyph, and solid ink belongs to a named family with a slot rule.");
	console.error('See docs/web/design.md, "Iconography and control surfaces".');
	console.error("");
	for (const e of errors) console.error(`  ${e}`);
	process.exit(1);
}

console.log(`${relative(process.cwd(), ROOT)}: icon contract OK`);
