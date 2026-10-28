// ============================================================================
// The icon set — the one source for every glyph the client draws, and the
// registry for role → symbol (see docs/web/design.md "Iconography and control
// surfaces"). Exports are named `<Role>Icon`; a feature imports here instead of
// inlining an `<svg>`.
//
// Geometry contract, applied inside the viewBox so no call site tunes it:
//   - `0 0 16 16` viewBox, 12×12 live area centred at 2..14. Ink stays inside
//     the live area except round caps and joins, which may cross it by half a
//     stroke, and a glyph authored elsewhere is *fitted* to it rather than
//     merely contained: the larger ink dimension lands on 12 and the smaller one
//     follows the aspect ratio (`liveFit`). Containment would accept any scale
//     at or below 0.75×, which is how a set ends up with marks that look right
//     one at a time and mismatched in a row.
//   - Glyph art is either authored directly in the live area (outline glyphs,
//     carets, transport solids) or imported on the full 16 box and fitted by its
//     ink box (the solid object marks).
//   - Stroke weight is stated in rendered pixels: 1.5px at the 16 and 20 slots,
//     1.25px at 12 and 14, converted to viewBox units by `strokeFor`. A fixed
//     viewBox stroke would make the same glyph a third heavier at 20px than at
//     14px, which is how a shared set drifts into two weights.
//
// Two ink modes, assigned by family:
//   - outline (default): `OutlineIcon`, one stroke, no fill.
//   - solid, a closed set of three families with their own slot rules:
//     * object marks (Copy, Check, Eye, Wrap, Markdown) sit beside Streamdown's
//       own solid copy pair and must match it in the same row. 12 and 14 only —
//       a filled symbol at 16 or 20 reads as a badge rather than a control.
//     * menu marks (More) are made of dots, which have no outline form: a
//       stroked dot at 14px closes its own counter and reads as a smudge. 12 and
//       14, by the same badge argument.
//     * transport solids (Record, ArrowUp, Stop) are filled because solidity is
//       the meaning, and live at 16 inside a filled box that carries the size.
//     Carets are solid for a third reason: rotation is their state (`CaretIcon`).
//     scripts/check-bridge-icon-contract.mjs enforces the families.
//
// Every icon is memoized: props are two primitives, so a memo'd icon never
// re-renders for a parent's streaming churn (the conversation shell and the
// tool cards re-render on every delta while their leaf views bail).
// ============================================================================

import { memo, type ReactNode } from "react";

/** The four legal glyph slots. A feature picks a slot, never a number: 12 for
 * meta marks, 14 for compact control rows, 16 for controls, 20 for chrome. */
export type IconSize = 12 | 14 | 16 | 20;

interface IconProps {
	size?: IconSize;
	className?: string;
}

const VIEWBOX = 16;

/** Rendered stroke weight per slot, in viewBox units. */
function strokeFor(size: number): number {
	return ((size >= 16 ? 1.5 : 1.25) * VIEWBOX) / size;
}

/** A glyph's ink extent in its own art box, `[x0, y0, x1, y1]`. */
type InkBox = readonly [x0: number, y0: number, x1: number, y1: number];

/** Fit a foreign art box into the live area: the larger ink dimension lands on
 * 12, the smaller follows the aspect ratio, and the result is centred on (8,8).
 * One constant cannot do this — the solid object marks' source art spans 16×10
 * (Markdown) to 14×15 (Copy), so a fixed 0.75 fits the widest and leaves Copy
 * 12% narrow. Shape and fill rule stay Streamdown's; only the frame is fitted. */
function liveFit([x0, y0, x1, y1]: InkBox): string {
	const scale = 12 / Math.max(x1 - x0, y1 - y0);
	const tx = 8 - (scale * (x0 + x1)) / 2;
	const ty = 8 - (scale * (y0 + y1)) / 2;
	// Four decimals is the readable form of an exact-enough fit: it keeps the
	// transform attribute stable across runs instead of serialising float noise.
	const n = (v: number) => Number(v.toFixed(4));
	return `matrix(${n(scale)} 0 0 ${n(scale)} ${n(tx)} ${n(ty)})`;
}

const OutlineIcon = memo(function OutlineIcon({ size = 16, className, children }: IconProps & { children: ReactNode }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
			fill="none"
			stroke="currentColor"
			strokeWidth={strokeFor(size)}
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			aria-hidden="true"
		>
			{children}
		</svg>
	);
});

const SolidIcon = memo(function SolidIcon({ size = 16, className, children }: IconProps & { children: ReactNode }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
			fill="currentColor"
			className={className}
			aria-hidden="true"
		>
			{children}
		</svg>
	);
});

// ── Directional ───────────────────────────────────────────────────────────
// Chevrons are outline: they point. The caret is solid: rotation is its state
// (folded → open), and a hollow caret reads as a broken chevron.

export const ChevronDownIcon = memo(function ChevronDownIcon(props: IconProps) {
	return (
		<OutlineIcon {...props}>
			<path d="M3.5 6L8 10.5L12.5 6" />
		</OutlineIcon>
	);
});

export const ChevronUpIcon = memo(function ChevronUpIcon(props: IconProps) {
	return (
		<OutlineIcon {...props}>
			<path d="M3.5 10L8 5.5L12.5 10" />
		</OutlineIcon>
	);
});

export const ChevronLeftIcon = memo(function ChevronLeftIcon(props: IconProps) {
	return (
		<OutlineIcon {...props}>
			<path d="M10 3.5L5.5 8L10 12.5" />
		</OutlineIcon>
	);
});

export const ChevronRightIcon = memo(function ChevronRightIcon(props: IconProps) {
	return (
		<OutlineIcon {...props}>
			<path d="M6 3.5L10.5 8L6 12.5" />
		</OutlineIcon>
	);
});

/** Fold caret — "there is more inside". Solid by definition, and the only
 * directional mark drawn that way; `direction` is the state (folded / active /
 * open), so a consumer never rotates it in CSS. The path is authored symmetric
 * about (8,8) because the three directions are one path under rotation: an
 * off-centre source box would orbit the rotation origin instead of turning in
 * place. */
export const CaretIcon = memo(function CaretIcon({
	direction = "right",
	...rest
}: IconProps & { direction?: "right" | "down" | "diagonal" }) {
	const rotate = direction === "down" ? "rotate(90 8 8)" : direction === "diagonal" ? "rotate(45 8 8)" : undefined;
	return (
		<SolidIcon {...rest}>
			<path d="M5.5 3l5 5-5 5z" transform={rotate} />
		</SolidIcon>
	);
});

// Ink extents of the imported art, measured from each path's coordinates.
// `liveFit` maps these onto the 12x12 live area.
const COPY_INK: InkBox = [1, 0.5, 15, 15.5]; // 14×15 — the art fills the box vertically, not horizontally
const CHECK_INK: InkBox = [0.439346, 2.93933, 15.5607, 14.0066]; // 15.12×11.07 — the widest mark in the set
const EYE_INK: InkBox = [1, 3.25, 15, 13.75]; // 14×10.5
const WRAP_INK: InkBox = [2, 3.5, 15.15, 12]; // 13.15×8.5
const MARKDOWN_INK: InkBox = [0, 3, 16, 13]; // 16×10 — the widest, so it keeps the family's smallest scale (0.75)

// ── Objects ───────────────────────────────────────────────────────────────

/** Copy — replicates streamdown's bundled CopyIcon exactly (evenodd fill,
 * currentColor) so the turn-text Copy button and the code-block Copy button
 * rendered by streamdown read as one icon. Solid because the renderer's is. */
export const CopyIcon = memo(function CopyIcon(props: IconProps) {
	return (
		<SolidIcon {...props}>
			<g transform={liveFit(COPY_INK)}>
				<path
					clipRule="evenodd"
					fillRule="evenodd"
					d="M2.75 0.5C1.7835 0.5 1 1.2835 1 2.25V9.75C1 10.7165 1.7835 11.5 2.75 11.5H3.75H4.5V10H3.75H2.75C2.61193 10 2.5 9.88807 2.5 9.75V2.25C2.5 2.11193 2.61193 2 2.75 2H8.25C8.38807 2 8.5 2.11193 8.5 2.25V3H10V2.25C10 1.2835 9.2165 0.5 8.25 0.5H2.75ZM7.75 4.5C6.7835 4.5 6 5.2835 6 6.25V13.75C6 14.7165 6.7835 15.5 7.75 15.5H13.25C14.2165 15.5 15 14.7165 15 13.75V6.25C15 5.2835 14.2165 4.5 13.25 4.5H7.75ZM7.5 6.25C7.5 6.11193 7.61193 6 7.75 6H13.25C13.3881 6 13.5 6.11193 13.5 6.25V13.75C13.5 13.8881 13.3881 14 13.25 14H7.75C7.61193 14 7.5 13.8881 7.5 13.75V6.25Z"
				/>
			</g>
		</SolidIcon>
	);
});

/** Check — the "copy landed" partner of `CopyIcon`, same box and fill. */
export const CheckIcon = memo(function CheckIcon(props: IconProps) {
	return (
		<SolidIcon {...props}>
			<g transform={liveFit(CHECK_INK)}>
				<path
					clipRule="evenodd"
					fillRule="evenodd"
					d="M15.5607 3.99999L15.0303 4.53032L6.23744 13.3232C5.55403 14.0066 4.44599 14.0066 3.76257 13.3232L4.2929 12.7929L3.76257 13.3232L0.969676 10.5303L0.439346 9.99999L1.50001 8.93933L2.03034 9.46966L4.82323 12.2626C4.92086 12.3602 5.07915 12.3602 5.17678 12.2626L13.9697 3.46966L14.5 2.93933L15.5607 3.99999Z"
				/>
			</g>
		</SolidIcon>
	);
});

/** Eye — "view": open the referenced file in the in-app viewer. */
export const EyeIcon = memo(function EyeIcon(props: IconProps) {
	return (
		<SolidIcon {...props}>
			<g transform={liveFit(EYE_INK)}>
				<path
					clipRule="evenodd"
					fillRule="evenodd"
					d="M8 3.25C4.66 3.25 1.85 5.42 1 8.5c.85 3.08 3.66 5.25 7 5.25s6.15-2.17 7-5.25c-.85-3.08-3.66-5.25-7-5.25zM2.6 8.5C3.4 6.2 5.5 4.75 8 4.75s4.6 1.45 5.4 3.75c-.8 2.3-2.9 3.75-5.4 3.75S3.4 10.8 2.6 8.5zM8 5.75a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 0 0 0-5.5zm-1.25 2.75a1.25 1.25 0 1 1 2.5 0 1.25 1.25 0 0 1-2.5 0z"
				/>
			</g>
		</SolidIcon>
	);
});

/** Word-wrap — text lines with a wrap arrow bending down to the next line. */
export const WrapIcon = memo(function WrapIcon(props: IconProps) {
	return (
		<SolidIcon {...props}>
			<g transform={liveFit(WRAP_INK)}>
				<path
					clipRule="evenodd"
					fillRule="evenodd"
					d="M2 3.5H9V5H2V3.5ZM2 10.5H8.5V12H2V10.5ZM12 3.5H13.5V9.2H12V3.5ZM10.35 9.2H15.15L12.75 11.9L10.35 9.2Z"
				/>
			</g>
		</SolidIcon>
	);
});

/** Markdown — the markdown mark (framed M and down arrow). */
export const MarkdownIcon = memo(function MarkdownIcon(props: IconProps) {
	return (
		<SolidIcon {...props}>
			<g transform={liveFit(MARKDOWN_INK)}>
				<path
					clipRule="evenodd"
					fillRule="evenodd"
					d="M1.5 3H14.5A1.5 1.5 0 0 1 16 4.5V11.5A1.5 1.5 0 0 1 14.5 13H1.5A1.5 1.5 0 0 1 0 11.5V4.5A1.5 1.5 0 0 1 1.5 3ZM0.9 4.4V11.6H15.1V4.4H0.9ZM3 10.6V5.4H4.5L5.7 7.1L6.9 5.4H8.4V10.6H7.1V7.7L5.7 9.6L4.3 7.7V10.6H3ZM10.4 5.4H11.8V8H13.3L11.1 11L9 8H10.4V5.4Z"
				/>
			</g>
		</SolidIcon>
	);
});

/** Folder — a directory: the file tree and the path-completion dropdown. */
export const FolderIcon = memo(function FolderIcon(props: IconProps) {
	return (
		<OutlineIcon {...props}>
			<path d="M2.5 5.75c0-.69.56-1.25 1.25-1.25h2.2l1.35 1.5h5.95c.69 0 1.25.56 1.25 1.25v4.5c0 .69-.56 1.25-1.25 1.25H3.75c-.69 0-1.25-.56-1.25-1.25z" />
		</OutlineIcon>
	);
});

/** File — everything that is not a directory: one mark for both surfaces. */
export const FileIcon = memo(function FileIcon(props: IconProps) {
	return (
		<OutlineIcon {...props}>
			<path d="M4.25 2.5h4.6l3 3v8c0 .55-.45 1-1 1h-6.6c-.55 0-1-.45-1-1v-10c0-.55.45-1 1-1z" />
			<path d="M8.75 2.6v3.1h3.1" />
		</OutlineIcon>
	);
});

/** Paperclip — "attach": add a file to the draft. */
export const PaperclipIcon = memo(function PaperclipIcon(props: IconProps) {
	return (
		<OutlineIcon {...props}>
			<path d="M10.2 4.4 5.6 9a1.15 1.15 0 0 0 1.63 1.63L11.8 6a2.3 2.3 0 0 0-3.25-3.25L4.1 7.2a3.45 3.45 0 0 0 4.88 4.88l4.45-4.45" />
		</OutlineIcon>
	);
});

/** Pencil — "edit": rewrite this message into a fork. */
export const PencilIcon = memo(function PencilIcon(props: IconProps) {
	return (
		<OutlineIcon {...props}>
			<path d="M3.1 12.9l.7-2.9 6.8-6.8 2.2 2.2-6.8 6.8z" />
			<path d="M9.9 4.1 11.7 2.3a1 1 0 0 1 1.4 0l.6.6a1 1 0 0 1 0 1.4L11.9 6.1" />
		</OutlineIcon>
	);
});

/** Undo — "take it back": an arrow curving back over what was inserted. */
export const UndoIcon = memo(function UndoIcon(props: IconProps) {
	return (
		<OutlineIcon {...props}>
			<path d="M2.5 6.5h6.25a3.75 3.75 0 1 1 0 7.5H6.5" />
			<path d="M5.5 3.5 2.5 6.5l3 3" />
		</OutlineIcon>
	);
});

/** Polish — "tidy this up": a sparkle, the one glyph in the dictation row that
 * is not a transport or an ending. Never a wand over text: the editor is
 * already full of text, and the words live in `aria-label`/`title`. */
export const PolishIcon = memo(function PolishIcon(props: IconProps) {
	return (
		<OutlineIcon {...props}>
			<path d="M6.5 2.5 7.6 5.4 10.5 6.5 7.6 7.6 6.5 10.5 5.4 7.6 2.5 6.5 5.4 5.4Z" />
			<path d="M11.8 9.6l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5Z" />
		</OutlineIcon>
	);
});

/** Close — "discard": drop the thing being shown, without acting on it. */
export const CloseIcon = memo(function CloseIcon(props: IconProps) {
	return (
		<OutlineIcon {...props}>
			<path d="M4.5 4.5l7 7" />
			<path d="M11.5 4.5l-7 7" />
		</OutlineIcon>
	);
});

/** Microphone — the dictation disclosure. The disclosure opens the toolbar;
 * it never records, so the transport dot (`RecordIcon`) is a different glyph:
 * one glyph cannot mean both "show the controls" and "record". */
export const MicIcon = memo(function MicIcon(props: IconProps) {
	return (
		<OutlineIcon {...props}>
			<rect x="6" y="1.75" width="4" height="7.5" rx="2" fill="currentColor" stroke="none" />
			<path d="M3.5 7.5a4.5 4.5 0 0 0 9 0" />
			<path d="M8 12v2.25" />
		</OutlineIcon>
	);
});

// ── Chrome ────────────────────────────────────────────────────────────────

/** Menu — the Sidebar disclosure (hamburger). */
export const MenuIcon = memo(function MenuIcon(props: IconProps) {
	return (
		<OutlineIcon {...props}>
			<path d="M2.5 4.5h11" />
			<path d="M2.5 8h11" />
			<path d="M2.5 11.5h11" />
		</OutlineIcon>
	);
});

/** Grid — "all Projects": a destination overview. Deliberately not a
 * directional arrow, which next to the fold carets would read as collapse. */
export const GridIcon = memo(function GridIcon(props: IconProps) {
	return (
		<OutlineIcon {...props}>
			<rect x="2.75" y="2.75" width="4.5" height="4.5" rx="1" />
			<rect x="8.75" y="2.75" width="4.5" height="4.5" rx="1" />
			<rect x="2.75" y="8.75" width="4.5" height="4.5" rx="1" />
			<rect x="8.75" y="8.75" width="4.5" height="4.5" rx="1" />
		</OutlineIcon>
	);
});

/** Plus — "new": open this Project's compose surface. */
export const PlusIcon = memo(function PlusIcon(props: IconProps) {
	return (
		<OutlineIcon {...props}>
			<path d="M8 2.5v11" />
			<path d="M2.5 8h11" />
		</OutlineIcon>
	);
});

/** Branch — the git mark, and the only one: the branch a turn was sent on, and
 * the badge counting files that differ from HEAD. The fork joins the trunk above
 * the trunk's own node, the way a branch actually leaves a line, so the two
 * nodes stay separate marks instead of the curve ending in a lump. Nodes are
 * filled dots: a 1.5px ring at the 12px slot closes its own hole, and a dot only
 * slightly wider than the stroke reads as a fat line end rather than a node, so
 * they are deliberately half again the stroke's width. */
export const BranchIcon = memo(function BranchIcon(props: IconProps) {
	return (
		<OutlineIcon {...props}>
			<path d="M4.8 3.9v6.3" />
			<path d="M11.2 5.7C11.2 7.8 8.6 9.2 4.8 9.2" />
			<circle cx="4.8" cy="11.4" r="1.4" fill="currentColor" stroke="none" />
			<circle cx="11.2" cy="4.3" r="1.4" fill="currentColor" stroke="none" />
		</OutlineIcon>
	);
});

/** Clock — History, the pane's own glyph in the TopBar and its header. */
export const ClockIcon = memo(function ClockIcon(props: IconProps) {
	return (
		<OutlineIcon {...props}>
			<circle cx="8" cy="8" r="5.25" />
			<path d="M8 4.75V8l2.5 1.5" />
		</OutlineIcon>
	);
});

/** Broken link — the connection down state. Two link halves pulled apart across
 * a diagonal gap, with the ticks a cut link leaves; the TopBar's motion
 * (trying) makes the halves reach for each other. */
export const BrokenLinkIcon = memo(function BrokenLinkIcon(props: IconProps) {
	return (
		<OutlineIcon {...props}>
			<path d="m12.6 8.2 1.15-1.15a3.33 3.33 0 0 0-4.71-4.71l-1.15 1.15" />
			<path d="m3.4 7.8-1.15 1.15a3.33 3.33 0 0 0 4.71 4.71l1.15-1.15" />
			<path d="M5.5 2.3v2" />
			<path d="M2.3 5.5h2" />
			<path d="M10.5 13.7v-2" />
			<path d="M13.7 10.5h-2" />
		</OutlineIcon>
	);
});

/** Warning — a status mark that has no data letter of its own: this listing
 * could not be read. A triangle rather than the `!` character it replaces,
 * which sat on the text baseline and borrowed the monospace data slot. */
export const WarningIcon = memo(function WarningIcon(props: IconProps) {
	return (
		<OutlineIcon {...props}>
			<path d="M8 3.1 13.35 12.5H2.65Z" />
			<path d="M8 6.4v3.3" />
			<path d="M8 11.6h.01" />
		</OutlineIcon>
	);
});

/** Pin — the model picker's pinned state. Outline when unpinned, solid when
 * pinned: the glyph is state only, hover changes the control's fill. */
export const PinIcon = memo(function PinIcon({ filled = false, ...rest }: IconProps & { filled?: boolean }) {
	return (
		<OutlineIcon {...rest}>
			<path
				d="M8 2.25c-1.2 0-2 .85-2 1.9 0 .75.3 1.15.3 1.85v1.9L4.9 9.35c-.2.15-.3.35-.3.55v.9c0 .3.2.5.5.5h5.8c.3 0 .5-.2.5-.5v-.9c0-.2-.1-.4-.3-.55L9.7 7.9V6c0-.7.3-1.1.3-1.85 0-1.05-.8-1.9-2-1.9z"
				fill={filled ? "currentColor" : "none"}
			/>
			<path d="M8 11.3v2.45" />
		</OutlineIcon>
	);
});

// ── Menu marks (solid) ────────────────────────────────────────────────────
// A mark made of dots has no outline form: at 14px a stroked dot closes its own
// counter and reads as a smudge, so the family is solid by construction rather
// than by taste.

/** More — the overflow of a row that holds more than one command. Deliberately
 * not the hamburger: that one is the Sidebar's disclosure, and one glyph cannot
 * mean both "open the app menu" and "this row has two commands". */
export const MoreIcon = memo(function MoreIcon(props: IconProps) {
	return (
		<SolidIcon {...props}>
			<circle cx="3.8" cy="8" r="1.15" />
			<circle cx="8" cy="8" r="1.15" />
			<circle cx="12.2" cy="8" r="1.15" />
		</SolidIcon>
	);
});

// ── Transport solids ──────────────────────────────────────────────────────

/** Record — the transport symbol for starting capture. Never a microphone:
 * that glyph belongs to the composer's disclosure. */
export const RecordIcon = memo(function RecordIcon(props: IconProps) {
	return (
		<SolidIcon {...props}>
			<circle cx="8" cy="8" r="4.5" />
		</SolidIcon>
	);
});

/** Arrow up — Send: commit the draft (or queue a steer). An arrow, not a paper
 * plane: the plane means "ship to somewhere", which is not what a send does. */
export const ArrowUpIcon = memo(function ArrowUpIcon(props: IconProps) {
	return (
		<SolidIcon {...props}>
			<path d="M8 2.75 12.4 7.15H9.8v6.1H6.2v-6.1H3.6z" />
		</SolidIcon>
	);
});

/** Stop — the interrupt. A solid rounded square, the transport opposite of
 * Record. */
export const StopIcon = memo(function StopIcon(props: IconProps) {
	return (
		<SolidIcon {...props}>
			<rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1.25" />
		</SolidIcon>
	);
});
