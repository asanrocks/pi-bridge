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
//   4. Every control resolves to a tier, or to a declared role with its reason.
//      The floating-chip category resolves through `floating`/`floatingOnImage`
//      (render/buttons.module.css), which compose ghost, so a floating control
//      is a tiered control and never needs a role entry.
//
//   5. A control's box follows its content: a button whose own children are
//      literal words takes the outlined tier (or filled, when it is its
//      surface's primary command), never the chromeless ghost/`dim` one. A
//      glyph marks itself as actionable and a word cannot — the rule that was
//      missing when `review` and `file` shipped as unbordered lowercase words
//      in git and diff cards. Rule 5 is also what keeps the floating category
//      glyph-only: `floating` composes ghost, so a worded floating chip fails
//      here and the illegal combination never needs its own check.
//
//   6. `filled` is a closed family: a surface's primary command, nothing else.
//      The files allowed to compose it are listed with the command each is the
//      primary of, so adding a filled control is a review-time decision, and a
//      stale entry fails so the list cannot rot.
//
//   7. The floating chip's edge has one home. `--shadow-chip` appears only in
//      the recipe (render/buttons.module.css) and the Streamdown override seam
//      (app/index.css, where a composed class cannot reach); a host restating
//      the recipe instead of composing `floating` fails.
//
//   8. A hidden element takes no hit area: a rule that fades anything to
//      `opacity: 0` — a button, a wrapper div holding buttons, a mark that
//      yields its slot — must also set `pointer-events: none`, restored by the
//      same rule that reveals it. Opacity is a paint channel, not an
//      interaction channel — the invisible copy chip once answered the tap
//      that meant to place a caret.
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
	// The picker's reorder handle: dots for the same reason, and it lives inside
	// the same 14px compact row.
	GripIcon: [12, 14],
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
	"ArrowDownIcon",
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
// Markup fixtures in tests are strings, not controls: a test that asserts on a
// rendered `<button>` tag has no tier to resolve and never ships. The scan is
// about what the document renders.
const sourceTsx = files.filter((f) => f.endsWith(".tsx") && !f.includes(".test."));
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

// Rule 6's allowlist: module path relative to web/src -> the command the file's
// filled control is the primary of. Global by path for the same reason as the
// role table: the decision is made at the point of use, and a stale entry
// fails the anti-rot check below.
const FILLED_SURFACES = new Map(
	Object.entries({
		"render/Dialog.module.css": "a dialog's confirm — the surface's primary command",
		"features/viewer/FileBrowser.module.css": "the compare menu's `Apply`",
		"features/conversation/turns.module.css": "the label panel's `Save` — the panel's one primary verb",
		"features/launcher/Launcher.module.css": "`Retry now` — the connection-down surface's only command",
		"features/composer/ComposeCard.module.css": "`Send` and `Stop` — the commit and the interrupt",
	}),
);

// Rule 7's two homes for the floating chip's edge token: the recipe itself, and
// the unlayered Streamdown override seam where a composed class cannot reach.
// Any other file restating `--shadow-chip` fails.
const CHIP_EDGE_HOME = new Map(
	Object.entries({
		"app/index.css": "the token's declaration and the [data-streamdown] seam — Streamdown's own copy button takes the recipe here because its class cannot be composed",
		"render/buttons.module.css": "the recipe's one home",
	}),
);

// class name -> why this button is not a tiered control. Global by name: a role
// is a role wherever it appears, and a name collision would be a spec bug first.
const CONTROL_ROLES = new Map(
	Object.entries({
		// Backdrops: a full-viewport hit area, not a control.
		overlay: "backdrop (click dismisses)",
		portalOverlay: "backdrop (click dismisses)",
		backdrop: "backdrop (click dismisses)",
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
		sidebarStateBtn: "a row's state indicator: a hit area around a 6px mark, not a boxed control",
		sidebarMenuItem: "menu row",
		sidebarMenuArchive: "menu row",
		sidebarFolderRow: "folder row (the fold target)",
		treeRow: "file tree row",
		pickerOption: "list row",
		comparePreset: "list row",
		completionItem: "list row",
		portalItemSelect: "list row",
		portalMore: "list row",
		supersededRow: "history row",
		// Fold headers: a full-width target carrying a caret and a label.
		actionCollapsed: "fold header",
		actionGroupHeader: "action group header (sticky fold)",
		sectionToggle: "file section fold header",
		editDiffSectionTitle: "diff section fold header",
		// Chips: a label or a value with its own geometry.
		msgLabel: "label chip (a value)",
		noticePath: "path chip (opens the file)",
		// Value controls: the words or the number are the content.
		topBarTitle: "the Session name (rename target)",
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
			// A class is declared in several blocks (its base, media branches, state
		// rules), and only the base carries `composes` — so a later block merges
		// into the record instead of replacing it, keeping the tier link. Rules
		// without any `composes` are recorded too: rule 8 asks about every class
		// used on a <button>, not only the ones that compose a tier.
			const record = rules.get(name);
			if (record) {
				record.body += `\n${block[2]}`;
				if (composes && record.from === undefined) {
					const value = composes[1].trim();
					record.names = value.split(" from ")[0].trim().split(/\s+/);
					record.from = /from\s+["']([^"']+)["']/.exec(value)?.[1];
				}
				continue;
			}
			const value = composes?.[1].trim();
			rules.set(name, {
				names: value === undefined ? [] : value.split(" from ")[0].trim().split(/\s+/),
				from: value === undefined ? undefined : /from\s+["']([^"']+)["']/.exec(value)?.[1],
				body: block[2],
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

/** The named tiers a class resolves to, so a rule can ask which box a control
 * ended up with rather than only whether it has one. */
function resolvedTiers(file, name, seen = new Set()) {
	const key = `${file}:${name}`;
	if (seen.has(key)) return new Set();
	seen.add(key);
	if (file.endsWith("buttons.module.css") && TIERS.has(name)) return new Set([name]);
	const rule = MODULES.get(file)?.get(name);
	if (!rule) return new Set();
	const next = rule.from === undefined ? file : join(file, "..", rule.from);
	const out = new Set();
	for (const composed of rule.names) for (const tier of resolvedTiers(next, composed, seen)) out.add(tier);
	return out;
}

const rolesUsed = new Set();
for (const file of sourceTsx) {
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

// ── Rule 5: a control's box follows its content ─────────────────────────────
//
// A glyph marks itself as actionable; a word cannot, so a button whose own
// children are literal words takes the outlined (or filled) tier and never the
// chromeless ghost/`dim` one. This is the rule that was missing when `review`
// and `file` sat in git and diff cards as unbordered lowercase words: they
// composed no tier at all, and a text control that composes none is either a
// role (a chip, a row, a link) or a bug. Only the children's own literal text
// counts — labels computed in an expression are invisible to a text scan and
// are covered by the tier they compose.
// The words are the value, not an action, so the button is a readout rather
// than a verb: it keeps the chromeless tier because a border would turn the
// model in force into a button, exactly as an icon would erase the value (see
// design.md's words-vs-glyph table). Literal labels are rare here — most
// readouts interpolate their value in an expression, which the scan skips — so
// each entry is a decision, not a default.
const TEXT_VALUE_OK = new Map(
	Object.entries({
		sidebarSectionToggle: "the section label is a fold-all toggle, not a verb — it sits in its header as a label",
		composerModelBtn: "the model readout's words are the value in force (its narrow-screen label is the literal `Models`)",
	}),
);

/** Index of the `>` that closes the tag starting at `start`, skipping quoted
 * strings and `{…}` expressions so an attribute's `=>` or a `">"` does not end
 * it early. */
function tagEnd(source, start) {
	let depth = 0;
	let quote = null;
	for (let i = start; i < source.length; i++) {
		const ch = source[i];
		if (quote) {
			if (ch === quote && source[i - 1] !== "\\") quote = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") quote = ch;
		else if (ch === "{") depth++;
		else if (ch === "}") depth = Math.max(0, depth - 1);
		else if (ch === ">" && depth === 0) return i;
	}
	return -1;
}

/** The literal words a button renders: its children with tags and `{…}`
 * expressions removed, which is what a hand-typed label looks like. A label
 * computed in an expression is invisible here by design — a value readout
 * (`{cost}`, `{modelLabel}`) is not a hand-written verb. */
function literalLabel(body) {
	let out = "";
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch === "{") {
			let depth = 0;
			for (; i < body.length; i++) {
				if (body[i] === "{") depth++;
				else if (body[i] === "}" && --depth === 0) break;
			}
			out += " ";
		} else if (ch === "<") {
			const end = tagEnd(body, i);
			if (end === -1) break;
			i = end;
			out += " ";
		} else out += ch;
	}
	return out.trim();
}

for (const file of sourceTsx) {
	const source = codeLines(readFileSync(file, "utf-8")).join("\n");
	const imports = new Map();
	for (const m of source.matchAll(/import\s+(\w+)\s+from\s+["']([^"']+\.module\.css)["']/g)) {
		imports.set(m[1], join(file, "..", m[2]));
	}
	for (const open of source.matchAll(/<button\b/g)) {
		const openEnd = tagEnd(source, open.index + open[0].length);
		if (openEnd === -1) continue;
		const tag = source.slice(open.index, openEnd + 1);
		const close = source.indexOf("</button>", openEnd);
		if (close === -1) continue;
		const label = literalLabel(source.slice(openEnd + 1, close));
		if (!/[A-Za-z]{2}/.test(label)) continue;
		const local = [...classNameExpression(tag).matchAll(/(\w+)\.(\w+)/g)]
			.map((m) => [m[1], m[2]])
			.filter(([variable]) => imports.has(variable));
		if (local.some(([, name]) => TEXT_VALUE_OK.has(name))) continue;
		// A role-listed class is a chip, a row, a fold header, or a link: not a verb.
		if (local.some(([, name]) => CONTROL_ROLES.has(name))) continue;
		const tiers = new Set();
		for (const [variable, name] of local) for (const tier of resolvedTiers(imports.get(variable), name)) tiers.add(tier);
		if (tiers.has("outlined") || tiers.has("filled")) continue;
		errors.push(
			`${file}: <button> renders the words "${label.replace(/\s+/g, " ")}" but composes ${tiers.size ? [...tiers].join("/") : "no tier"} — a glyph marks itself as actionable and a word cannot, so a text control takes the outlined tier (or filled, if it is its surface's primary command). See docs/web/design.md, "Iconography and control surfaces"`,
		);
	}
}

// ── Rule 6: a text control carries no glyph ─────────────────────────
//
// Text and a glyph are two ways of saying one thing, so a control takes one of
// them: a glyph marks itself actionable, and a word is marked by being read.
// A value chip that also wears a caret said the same thing twice, and the caret
// was the weaker half — it announced "opens" to a reader who had already read
// the value. The value readouts are recorded here so the rule has a subject; a
// worded chromeless control is a value disclosure (rule 5's `TEXT_VALUE_OK`),
// never a decoration carrier.
const TEXT_CONTROLS = new Map(
	Object.entries({
		composerModelBtn: "the model in force — a value readout",
		composerCostBtn: "the session cost — a value readout",
		changesBadge: "the uncommitted-file count — a value readout",
		stateChipBtn: "the comparison endpoint — a value chip",
		turnHeaderDate: "the turn's instant — a value readout",
		sidebarSectionToggle: "the fold-all label — a text control, not a verb",
	}),
);

// The two glyphs that are content rather than decoration, and stay: a fold caret
// IS the state (open/closed, like a check mark), and a clock stands in for an
// instant the text has no characters for.
const TEXT_GLYPH_OK = new Map(
	Object.entries({
		sidebarSectionToggle: "the caret is the fold state, not decoration",
		turnHeaderDate: "the clock is the value when no instant is known",
		changesBadge: "the branch mark names what the count counts",
	}),
);

for (const file of sourceTsx) {
	const source = codeLines(readFileSync(file, "utf-8")).join("\n");
	const imports = new Map();
	for (const m of source.matchAll(/import\s+(\w+)\s+from\s+["']([^"']+\.module\.css)["']/g)) {
		imports.set(m[1], join(file, "..", m[2]));
	}
	for (const open of source.matchAll(/<button\b/g)) {
		const openEnd = tagEnd(source, open.index + open[0].length);
		if (openEnd === -1) continue;
		const tag = source.slice(open.index, openEnd + 1);
		const close = source.indexOf("</button>", openEnd);
		if (close === -1) continue;
		const inner = source.slice(openEnd + 1, close);
		const glyph = /<\w*Icon\b/.exec(inner);
		if (!glyph) continue;
		const names = [...classNameExpression(tag).matchAll(/(\w+)\.(\w+)/g)]
			.map((m) => m[2])
			.filter((name) => TEXT_CONTROLS.has(name));
		const offending = names.filter((name) => !TEXT_GLYPH_OK.has(name));
		if (offending.length === 0) continue;
		errors.push(
			`${file}: <button className={…${offending.map((n) => `.${n}`).join(", ")}}> is a text control (${TEXT_CONTROLS.get(offending[0])}) but renders ${glyph[0].slice(1)} — a text-based control is text only: no leading mark, no trailing caret. Mark it with the hover fill and aria-expanded instead, or take the outlined tier. See docs/web/design.md, "Iconography and control surfaces"`,
		);
	}
}

// ── Rule 7: `filled` is a closed family ──────────────────────────────
//
// The tier's meaning is "this surface's one primary command". That cannot be
// checked from the CSS alone — the check is the list: a file composes `filled`
// only with a recorded reason, and an entry whose file no longer composes it
// fails below, so the family stays closed in both directions.
const filledUsed = new Set();
for (const [file, rules] of MODULES) {
	const rel = relative(ROOT, file).replace(/\\/g, "/");
	for (const [name, rule] of rules) {
		if (!rule.names.includes("filled")) continue;
		filledUsed.add(rel);
		const why = FILLED_SURFACES.get(rel);
		if (why === undefined) {
			errors.push(
				`${file}: .${name} composes "filled" outside the closed family — filled is a surface's primary command and nothing else; record this file in FILLED_SURFACES with the command it is the primary of, or take the outlined tier`,
			);
		}
	}
}

// ── Rule 7: the floating chip's edge has one home ──────────────────────
for (const f of walk(ROOT).filter((f) => f.endsWith(".css"))) {
	const rel = relative(ROOT, f).replace(/\\/g, "/");
	if (readFileSync(f, "utf-8").includes("--shadow-chip") && !CHIP_EDGE_HOME.has(rel)) {
		errors.push(
			`${f}: restates --shadow-chip — the floating chip's edge lives in render/buttons.module.css (plus the Streamdown seam in app/index.css); compose the floating tier instead of restating the recipe`,
		);
	}
}

// ── Rule 8: a hidden element takes no hit area ──────────────────────
//
// `opacity: 0` keeps hit-testing (opacity is a paint channel), so anything
// faded out to await its reveal still answers clicks — the invisible copy
// chip over prose once copied the message a tap meant to select text in. The
// check is not scoped to buttons: a wrapper that fades a whole cluster of
// controls is the same bug on a div, and a mark that yields its slot (the
// sidebar timestamp) is the same rule on a span. Scope is every rule whose
// selector names a class or an attribute, in every module plus the unlayered
// Streamdown seam in app/index.css; keyframe steps and bare element selectors
// name neither and are skipped, and so are pseudo-elements, whose hits bubble
// to the element they hang from. Only the hidden half is checked — the reveal
// must restore pointer-events on the same rule that restores opacity, which
// no scan here can see. `0.4` and other dim values are excluded on purpose: a
// visible-but-dim element is a state, not a hidden one.
for (const file of [...MODULES.keys(), join(ROOT, "app", "index.css")]) {
	const text = readFileSync(file, "utf-8");
	for (const block of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		// The selector is the chunk's last non-empty line, so a block inside a
		// media query reads as its own innermost selector.
		const selector = block[1]
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean)
			.pop();
		if (selector === undefined || !/[.[]/.test(selector) || selector.includes("::")) continue;
		if (!/\bopacity:\s*0(?:\.0+)?\s*;/.test(block[2])) continue;
		if (/pointer-events:\s*none/.test(block[2])) continue;
		errors.push(
			`${file}: ${selector} fades to opacity: 0 without pointer-events: none — an invisible element still answers clicks; take it out of hit-testing and let the same rule that reveals it restore pointer-events (docs/web/design.md, "A hidden control takes no hit area")`,
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

// Same anti-rot for the two rule-6/7 tables, under the same real-tree guard.
for (const rel of scannedFeatureModules ? FILLED_SURFACES.keys() : []) {
	if (!filledUsed.has(rel)) {
		errors.push(
			`${ROOT}: FILLED_SURFACES lists "${rel}" but no rule there composes "filled" — update FILLED_SURFACES in scripts/check-bridge-icon-contract.mjs so the closed family cannot rot`,
		);
	}
}
for (const rel of scannedFeatureModules ? CHIP_EDGE_HOME.keys() : []) {
	if (!readFileSync(join(ROOT, rel), "utf-8").includes("--shadow-chip")) {
		errors.push(
			`${ROOT}: CHIP_EDGE_HOME lists "${rel}" but it no longer mentions --shadow-chip — update CHIP_EDGE_HOME in scripts/check-bridge-icon-contract.mjs`,
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
