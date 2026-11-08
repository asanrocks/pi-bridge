// ============================================================================
// foldState — the sidebar's state-scoped fold algebra (ADR 23). Pure: the
// hook around it (useFolderExpansion) owns React state and persistence, and
// this module owns what a click means.
//
//   collapsed — nothing below the folder row
//   working   — the Project's notified and busy rows
//   all       — working rows + the parked (deferred) and inactive ones
//
// A folder with no working rows has only two states: the working step is
// skipped, because "working only" is indistinguishable from collapsed there.
// ============================================================================

export type FolderFoldState = "collapsed" | "working" | "all";

/** Click cycle order: collapsed → working → all → collapsed. */
const FOLD_CYCLE: Record<FolderFoldState, FolderFoldState> = {
	collapsed: "working",
	working: "all",
	all: "collapsed",
};

/** Rank used to find the highest state present in a mixed set. */
const FOLD_RANK: Record<FolderFoldState, number> = { collapsed: 0, working: 1, all: 2 };

/** The names the fold record used before ADR 23: a persisted map is migrated
 * on read, so a returning user keeps their folds. */
const LEGACY_FOLDS: Record<string, FolderFoldState> = { folded: "collapsed", active: "working", open: "all" };

/** One click of the fold cycle for one folder. */
export function nextFoldState(current: FolderFoldState, hasWorking: boolean): FolderFoldState {
	if (!hasWorking) return current === "all" ? "collapsed" : "all";
	return FOLD_CYCLE[current];
}

/** The state a folder actually renders as: the working step with no working
 * rows is collapsed in disguise, so a stale persisted `working` never claims
 * content that does not exist. */
export function effectiveFold(state: FolderFoldState, hasWorking: boolean): FolderFoldState {
	return state === "working" && !hasWorking ? "collapsed" : state;
}

/** The Projects header's one glowl target: the smallest step strictly above
 * every folder's effective state, up the ladder collapsed → working → all
 * (the working step exists only when some folder has working rows), wrapping
 * to collapsed at the top. Strictly-above means a click always changes every
 * folder — no dead clicks, and fold/unfold mixing never survives a click. */
export function foldAllTarget(
	folds: Record<string, FolderFoldState>,
	projectIds: string[],
	hasWorkingById: Record<string, boolean>,
): FolderFoldState {
	if (projectIds.length === 0) return "collapsed";
	// The global ladder: `working` is a reachable step only when some folder has
	// working rows — applied to a set with none, it renders collapsed everywhere
	// and the click would do nothing visible.
	const ladder: FolderFoldState[] = projectIds.some((id) => hasWorkingById[id])
		? ["collapsed", "working", "all"]
		: ["collapsed", "all"];
	const maxRank = Math.max(
		...projectIds.map((id) => FOLD_RANK[effectiveFold(folds[id] ?? "working", hasWorkingById[id])]),
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
		if (state === "collapsed" || state === "working" || state === "all") out[id] = state;
	}
	return out;
}
