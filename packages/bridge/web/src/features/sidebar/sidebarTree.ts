// ============================================================================
// sidebarTree — a Project's rows as the tree their stems describe.
//
// A spawned Session is stored under a directory named after its spawner, so the
// address alone says who the parent is: the stem without its last segment.
// Nesting is therefore a projection of the rows at hand, with no second source
// and no separate query.
//
// The tree is the display unit, not the location group: a child is drawn under
// its spawner even when its own place differs, so a fan-out never looks
// disconnected. A root's place picks the group — Inbox, Later, or the archived
// tail — and its descendants come with it. The exception keeps active work
// visible: a descendant whose place is more attentive than its parent's (an
// Inbox child of a parked or archived spawner) is promoted to a root of its own
// group, carrying the spawner reference that the row's jump and mark read.
//
// A spawner that is not in the rows at hand (an archived parent whose page is
// not loaded) leaves its children at depth 0 with the reference, as before:
// nothing can nest under a row that is not rendered. Live agent rows arrive
// without a place of their own (see `ProjectRows.agent`); they join this tree
// and are never a group root unless their spawner is absent.
//
// Not every row is drawn: an unplaced row is ambient work, so it earns a place
// only while it works or while the reader has it (or its spawner) open. See
// `drawnRows`.
// ============================================================================

import type { SessionInfo, SessionLocation } from "../../../../src/core/index.ts";
import type { ProjectRows } from "./sessionRows.ts";

export interface RowedSession {
	readonly session: SessionInfo;
	/** Indentation depth: 0 for a root or an orphan, one more per ancestor drawn
	 * above it in the same group. */
	readonly depth: number;
	/** The spawner's stem, for the row's jump-to-parent affordance. Undefined for
	 * a Session nothing spawned. */
	readonly parentStem: string | undefined;
	/** Direct children drawn under this row, for the parent's count. */
	readonly childCount: number;
	/** The spawner's row when this row was promoted out of its tree because its
	 * own place is more attentive: the row names who it belongs to even though it
	 * is not drawn inside it. Undefined when the spawner is not rendered at all. */
	readonly promotedParent: SessionInfo | undefined;
}

export interface SidebarTree {
	/** Roots placed in Inbox, each followed by its descendants. */
	readonly inbox: RowedSession[];
	/** Roots placed in Later, each followed by its descendants. */
	readonly later: RowedSession[];
	/** Roots placed in Archive, from the loaded history page. */
	readonly archived: RowedSession[];
}

/** What the reader has open. A spawned Session carries no place of its own, so
 * the Session on screen is what decides whether it is drawn. */
export interface SidebarView {
	/** The attached Session's stem, or null when no Session is open (the Project
	 * home, the launcher). */
	readonly viewedStem: string | null;
}

/** The stem a Session was spawned under, or undefined for a top-level Session. */
export function parentStemOf(stem: string): string | undefined {
	const slash = stem.lastIndexOf("/");
	return slash <= 0 ? undefined : stem.slice(0, slash);
}

/** How much the user's attention a place implies. A descendant is only hidden
 * under an ancestor that is at least as attentive: work that moved to Inbox or
 * Later must not disappear inside a parked or archived tree. */
const ATTENTION: Record<SessionLocation, number> = { inbox: 2, later: 1, archive: 0 };

/** The rows that earn a place in the rail. A placed row (Inbox or Later) always
 * does: the user decided it, so the rail may not hide work the folder's counts
 * still report. An archived row — an unplaced spawned Session, or a file from
 * the tail — is ambient work, drawn only while it is busy, while it is the
 * Session being read, or while the Session being read is its spawner. Switching
 * away therefore ends a fan-out instead of leaving every worker in the rail.
 * A spawned Session the user promoted stays visible as a member of its group. */
function drawnRows(all: readonly SessionInfo[], view: SidebarView): SessionInfo[] {
	const viewed = view.viewedStem;
	return all.filter((row) => {
		// A Session nothing spawned is the user's own history, whatever its place.
		if (parentStemOf(row.stem) === undefined) return true;
		if (row.location !== "archive") return true;
		if (row.activity !== undefined) return true;
		if (viewed === null) return false;
		return row.stem === viewed || parentStemOf(row.stem) === viewed;
	});
}

/** Build the three render groups from a Project's split rows, omitting the
 * ambient descendants the reader is not looking at (`drawnRows`). */
export function buildSidebarTree(rows: ProjectRows, view: SidebarView): SidebarTree {
	// The input order is the queue's (Inbox, then Later) followed by the history
	// page; roots keep it, and siblings keep it among themselves.
	const all = drawnRows([...rows.inbox, ...rows.later, ...rows.archived, ...rows.agent], view);
	const byStem = new Map(all.map((row) => [row.stem, row]));
	const children = new Map<string, SessionInfo[]>();
	const roots: SessionInfo[] = [];
	const promotedParent = new Map<string, SessionInfo>();
	for (const row of all) {
		const parentStem = parentStemOf(row.stem);
		const parent = parentStem === undefined ? undefined : byStem.get(parentStem);
		if (parent !== undefined && ATTENTION[row.location] <= ATTENTION[parent.location]) {
			const siblings = children.get(parent.stem);
			if (siblings === undefined) children.set(parent.stem, [row]);
			else siblings.push(row);
			continue;
		}
		roots.push(row);
		if (parent !== undefined) promotedParent.set(row.stem, parent);
	}

	const byPlace: Record<SessionLocation, RowedSession[]> = { inbox: [], later: [], archive: [] };
	// One walk per root, appended into the root's own group: a descendant's place
	// never opens a second copy, so every rendered row appears exactly once.
	const walk = (row: SessionInfo, depth: number, out: RowedSession[]): void => {
		const own = children.get(row.stem) ?? [];
		out.push({
			session: row,
			depth,
			parentStem: parentStemOf(row.stem),
			childCount: own.length,
			promotedParent: promotedParent.get(row.stem),
		});
		for (const child of own) walk(child, depth + 1, out);
	};
	for (const root of roots) walk(root, 0, byPlace[root.location]);
	return { inbox: byPlace.inbox, later: byPlace.later, archived: byPlace.archive };
}
