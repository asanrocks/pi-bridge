// ============================================================================
// foldState — the sidebar folder model. Pure: the hook around it
// (useFolderExpansion) owns React state and persistence, and this module owns
// what a click means.
//
// A folder has a heading state (`folded`) and a reveal ladder that only ever
// adds rows: Inbox → Inbox plus Later → Inbox plus Later plus the archived
// history. The reveal is remembered while the folder is folded, so unfolding
// resumes the list where the reader left it. A step that would add no rows is
// skipped, because a step rendering the step below it is a click that does
// nothing.
// ============================================================================

export type FolderReveal = "inbox" | "later" | "all";

export interface FolderState {
	folded: boolean;
	/** Remembered across a fold: the heading never changes what is revealed. */
	reveal: FolderReveal;
}

/** An unvisited folder: unfolded at the attention list, raised to its floor by
 * `effectiveReveal` when it has no Inbox rows. Leftover work is one glance
 * away, and no archived page is requested until Load more reaches the cap. */
export const DEFAULT_FOLDER_STATE: FolderState = { folded: false, reveal: "inbox" };

const RANK: Record<FolderReveal, number> = { inbox: 0, later: 1, all: 2 };

/** The lowest step that shows rows of its own, which is where a folder lands
 * when it unfolds and how far Show less retreats. */
export function floorReveal(hasInbox: boolean, hasLater: boolean): FolderReveal {
	if (hasInbox) return "inbox";
	return hasLater ? "later" : "all";
}

/** The step a folder actually renders at: a remembered reveal below the floor
 * is raised to it, so stale persistence never shows an empty list. */
export function effectiveReveal(reveal: FolderReveal, hasInbox: boolean, hasLater: boolean): FolderReveal {
	const floor = floorReveal(hasInbox, hasLater);
	return RANK[reveal] < RANK[floor] ? floor : reveal;
}

/** One press of Load more: the next step that adds rows. `all` is the cap and
 * is never a dead press — entering it fetches the archived page. */
export function advanceReveal(reveal: FolderReveal, hasLater: boolean): FolderReveal {
	if (reveal === "inbox") return hasLater ? "later" : "all";
	return "all";
}

/** One press of Show less: the previous step that removes rows, never below
 * the floor (where the control is not rendered). */
export function retreatReveal(reveal: FolderReveal, hasInbox: boolean, hasLater: boolean): FolderReveal {
	return reveal === "all" && hasLater ? "later" : floorReveal(hasInbox, hasLater);
}

/** The folder heading's one gesture: folding keeps the reveal for the next
 * unfold. */
export function toggleFolded(state: FolderState): FolderState {
	return { folded: !state.folded, reveal: state.reveal };
}

/** The Projects header's one target: fold everything when any folder is
 * unfolded, unfold everything when all are folded. Each folder resumes its own
 * reveal, so the header never rewrites what a click on a folder decided. */
export function foldAllTarget(states: readonly FolderState[]): boolean {
	return !states.every((state) => state.folded);
}

/** The names the fold record used before this model: the pre-location state
 * names and the tri-state cycle's values. A record is migrated on read, so a
 * returning user keeps their folds. */
const LEGACY_FOLDS: Record<string, FolderState> = {
	collapsed: { folded: true, reveal: "inbox" },
	folded: { folded: true, reveal: "inbox" },
	active: { folded: false, reveal: "inbox" },
	working: { folded: false, reveal: "inbox" },
	inbox: { folded: false, reveal: "inbox" },
	all: { folded: false, reveal: "all" },
	open: { folded: false, reveal: "all" },
};

/** The persisted fold record, migrated and narrowed. Stored JSON is a trust
 * boundary — an older release wrote other shapes — so unknown states are
 * dropped rather than trusted, and the legacy names are translated. */
export function migrateFoldRecord(parsed: unknown): Record<string, FolderState> {
	// v1 was an array of expanded project ids.
	if (Array.isArray(parsed)) {
		const out: Record<string, FolderState> = {};
		for (const id of parsed) if (typeof id === "string") out[id] = { folded: false, reveal: "all" };
		return out;
	}
	if (parsed === null || typeof parsed !== "object") return {};
	const out: Record<string, FolderState> = {};
	for (const [id, value] of Object.entries(parsed)) {
		const state = readFolderState(value);
		if (state !== null) out[id] = state;
	}
	return out;
}

function readFolderState(value: unknown): FolderState | null {
	if (typeof value === "string") return LEGACY_FOLDS[value] ?? null;
	if (value === null || typeof value !== "object") return null;
	const { folded, reveal } = value as { folded?: unknown; reveal?: unknown };
	if (typeof folded !== "boolean") return null;
	if (reveal === "inbox" || reveal === "later" || reveal === "all") return { folded, reveal };
	return null;
}
