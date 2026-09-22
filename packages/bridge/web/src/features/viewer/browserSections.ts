// ============================================================================
// browserSections — the review presentation's section addressing and its
// tree-follow rule (ADR 14). Pure and store-free: the container owns the DOM
// and effects and calls these.
//
// A review section is addressed by the *absolute* path of its file, the same
// form a tree node carries, so a tree click and its section agree on one key
// (a relative directive path keyed sections differently and silently broke
// click-to-open). `visibleSectionKey` is the tree-follow rule: the tree
// highlights the section the viewport is reading.
// ============================================================================

import { resolveAgainst } from "../../infra/lib/paths.ts";

/** The absolute key one review section and its tree node share. */
export function sectionKey(root: string, filePath: string): string {
	return resolveAgainst(root, filePath);
}

/** One section's position within the scrolling content pane. */
export interface SectionRect {
	key: string;
	/** Section's top edge relative to the scroll container's viewport. */
	top: number;
}

/** The section the viewport is reading: the last one whose top edge has
 * reached the container's top, or the first when the container sits above
 * every section (e.g. the start of the list). Order is DOM order, which is
 * the directive's order. */
export function visibleSectionKey(sections: readonly SectionRect[], containerTop: number, slack = 8): string | null {
	if (sections.length === 0) return null;
	let current: string | null = null;
	for (const section of sections) {
		if (section.top > containerTop + slack) break;
		current = section.key;
	}
	return current ?? sections[0]!.key;
}
