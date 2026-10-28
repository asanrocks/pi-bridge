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
