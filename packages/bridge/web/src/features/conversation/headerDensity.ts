// headerDensity — the conversation column's width mapped to the turn header's
// control budget (ADR 21).
//
// The header reserves space for the date, the label, a trailing reading, and
// the menu before it considers inline controls, so the tier is a function of
// the *column*, not the viewport or the pointer type: a narrow desktop pane and
// a phone have the same problem, and folding controls into the menu on one but
// not the other is how the old header painted metadata over itself.
//
// Ownership is exclusive (ADR 21): a command is either an inline header control
// or a menu entry, never both. That is why the caller derives both surfaces from
// the same `inlineControls` answer instead of testing the tier twice.

/** At or above this width the header keeps Copy, the sibling pager, and Edit. */
export const WIDE_HEADER_WIDTH = 560;

/** At or above this width the header keeps Edit. Below it the menu owns every
 *  command, because a single icon control plus the reserved reading no longer
 *  leaves room for a label worth reading. */
export const COMPACT_HEADER_WIDTH = 340;

export type HeaderDensity = "wide" | "compact" | "narrow";

/** The tier a measured column width reads as. An unmeasured column (`0`, or a
 *  non-finite reading during layout) takes the narrow tier: showing fewer
 *  controls for one frame is invisible, while showing more than fits is the
 *  collision this policy exists to prevent. */
export function headerDensity(width: number): HeaderDensity {
	if (!Number.isFinite(width) || width < COMPACT_HEADER_WIDTH) return "narrow";
	if (width < WIDE_HEADER_WIDTH) return "compact";
	return "wide";
}

/** Which commands the header renders inline at a tier. */
export interface InlineControls {
	copy: boolean;
	/** The sibling pager — only meaningful when the turn has siblings. */
	pager: boolean;
	edit: boolean;
}

export function inlineControls(density: HeaderDensity): InlineControls {
	return {
		copy: density === "wide",
		pager: density === "wide",
		edit: density !== "narrow",
	};
}
