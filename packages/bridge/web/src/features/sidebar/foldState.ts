// ============================================================================
// foldState — the sidebar's fold algebra. Pure: the hook around it
// (useFolderExpansion) owns React state and persistence, and this module owns
// what a click means.
//
//   collapsed — nothing below the folder row
//   inbox     — the Project's Inbox rows (the attention list)
//   all       — Inbox rows + the Later and archived ones
//
// A folder with no Inbox rows has only two states: the inbox step is skipped,
// because "inbox only" is indistinguishable from collapsed there.
// ============================================================================

export type FolderFoldState = "collapsed" | "inbox" | "all";

/** Click cycle order: collapsed → inbox → all → collapsed. */
const FOLD_CYCLE: Record<FolderFoldState, FolderFoldState> = {
	collapsed: "inbox",
	inbox: "all",
	all: "collapsed",
};

/** Rank used to find the highest state present in a mixed set. */
const FOLD_RANK: Record<FolderFoldState, number> = { collapsed: 0, inbox: 1, all: 2 };

/** The names the fold record used before the location rename: a persisted map
 * is migrated on read, so a returning user keeps their folds. */
const LEGACY_FOLDS: Record<string, FolderFoldState> = {
	folded: "collapsed",
	active: "inbox",
	working: "inbox",
	open: "all",
};

/** One click of the fold cycle for one folder. */
export function nextFoldState(current: FolderFoldState, hasInbox: boolean): FolderFoldState {
	if (!hasInbox) return current === "all" ? "collapsed" : "all";
	return FOLD_CYCLE[current];
}

/** The state a folder actually renders as: the inbox step with no Inbox rows
 * is collapsed in disguise, so a stale persisted `inbox` never claims content
 * that does not exist. */
export function effectiveFold(state: FolderFoldState, hasInbox: boolean): FolderFoldState {
	return state === "inbox" && !hasInbox ? "collapsed" : state;
}

/** The Projects header's one target: the smallest step strictly above every
 * folder's effective state, up the ladder collapsed → inbox → all (the inbox
 * step exists only when some folder has Inbox rows), wrapping to collapsed at
 * the top. Strictly-above means a click always changes every folder — no dead
 * clicks, and fold/unfold mixing never survives a click. */
export function foldAllTarget(
	folds: Record<string, FolderFoldState>,
	projectIds: string[],
	hasInboxById: Record<string, boolean>,
): FolderFoldState {
	if (projectIds.length === 0) return "collapsed";
	// The global ladder: `inbox` is a reachable step only when some folder has
	// Inbox rows — applied to a set with none, it renders collapsed everywhere
	// and the click would do nothing visible.
	const ladder: FolderFoldState[] = projectIds.some((id) => hasInboxById[id])
		? ["collapsed", "inbox", "all"]
		: ["collapsed", "all"];
	const maxRank = Math.max(
		...projectIds.map((id) => FOLD_RANK[effectiveFold(folds[id] ?? "inbox", hasInboxById[id])]),
	);
	return ladder.find((state) => FOLD_RANK[state] > maxRank) ?? "collapsed";
}

/** The persisted fold record, migrated and narrowed: unknown states are
 * dropped rather than trusted, and the legacy names are translated. */
export function migrateFoldRecord(parsed: unknown): Record<string, FolderFoldState> {
	// v1 was an array of expanded project ids.
	if (Array.isArray(parsed)) {
		const out: Record<string, FolderFoldState> = {};
		for (const id of parsed) if (typeof id === "string") out[id] = "all";
		return out;
	}
	if (parsed === null || typeof parsed !== "object") return {};
	const out: Record<string, FolderFoldState> = {};
	for (const [id, value] of Object.entries(parsed)) {
		const state = LEGACY_FOLDS[String(value)] ?? value;
		if (state === "collapsed" || state === "inbox" || state === "all") out[id] = state;
	}
	return out;
}
