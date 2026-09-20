// ============================================================================
// useFolderExpansion — sidebar folder fold state, tri-state per Project:
//   folded — nothing below the folder row
//   active — only the pinned active rows
//   open   — active rows + fetched history
// Missing entries default to "active" (at-a-glance liveness without
// history). A folder with no pinned active rows has only two states: the
// active step is skipped (and a stale persisted "active" renders folded),
// because "active only" is indistinguishable from folded there. Adds, never
// removes — a manual fold stays respected.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from "react";

const LS_FOLDERS_KEY = "pi-bridge:sidebar-folders";

export type FolderFoldState = "folded" | "active" | "open";

/** Click cycle order: folded → active → open → folded. */
const FOLD_CYCLE: Record<FolderFoldState, FolderFoldState> = {
	folded: "active",
	active: "open",
	open: "folded",
};

/** Rank used to find the lowest state present in a mixed set. */
const FOLD_RANK: Record<FolderFoldState, number> = { folded: 0, active: 1, open: 2 };

/** One click of the fold cycle for one folder. */
export function nextFoldState(current: FolderFoldState, hasActive: boolean): FolderFoldState {
	if (!hasActive) return current === "open" ? "folded" : "open";
	return FOLD_CYCLE[current];
}

export function useFolderExpansion(
	/** All configured Project ids — the fan-out target of the header toggle. */
	projectIds: string[],
	/** The attached Project, or null on the Launcher. */
	currentProjectId: string | null,
	/** Open session's stem, or null on the Project home. */
	currentStem: string | null,
): {
	folds: Record<string, FolderFoldState>;
	cycleFolder: (projectId: string, hasActive: boolean) => void;
	/** The Projects header: apply ONE uniform fold state to every folder —
	 * the smallest step strictly above every folder's current effective
	 * state, up the ladder folded → active → open (the "active" step exists
	 * only when some folder has pinned rows), wrapping to folded at the top.
	 * Strictly-above means a click always changes every folder: no dead
	 * clicks, and fold/unfold mixing never survives a click. */
	cycleAllFolders: (hasActiveById: Record<string, boolean>) => void;
} {
	const [folds, setFolds] = useState<Record<string, FolderFoldState>>(() => {
		try {
			const stored = localStorage.getItem(LS_FOLDERS_KEY);
			if (stored !== null) {
				const parsed: unknown = JSON.parse(stored);
				if (Array.isArray(parsed)) {
					// v1 format (array of expanded ids): expanded → open, the rest
					// fall back to the "active" default.
					const out: Record<string, FolderFoldState> = {};
					for (const id of parsed) if (typeof id === "string") out[id] = "open";
					return out;
				}
				if (parsed !== null && typeof parsed === "object") return parsed as Record<string, FolderFoldState>;
			}
		} catch {
			/* ignore */
		}
		return {};
	});

	// Landing on a Project's home (no session attached) opens its folder — the
	// browse-this-project stance. The same holds at boot for a session URL: the
	// first non-null current Project opens even when a stem is attached —
	// first-paint context, unlike a live session switch, where unfolding is
	// noise (a pinned row is already visible regardless of folding). Adds,
	// never removes — a manual fold stays respected.
	const didBootExpandRef = useRef(false);
	useEffect(() => {
		if (currentProjectId === null) return;
		const isBoot = !didBootExpandRef.current;
		didBootExpandRef.current = true;
		if (!isBoot && currentStem !== null) return;
		setFolds((s) => (s[currentProjectId] === "open" ? s : { ...s, [currentProjectId]: "open" }));
	}, [currentProjectId, currentStem]);

	const cycleFolder = useCallback((projectId: string, hasActive: boolean) => {
		setFolds((s) => ({ ...s, [projectId]: nextFoldState(s[projectId] ?? "active", hasActive) }));
	}, []);

	const cycleAllFolders = useCallback(
		(hasActiveById: Record<string, boolean>) => {
			setFolds((s) => {
				if (projectIds.length === 0) return s;
				const effective = (id: string): FolderFoldState => {
					const f = s[id] ?? "active";
					return f === "active" && !hasActiveById[id] ? "folded" : f;
				};
				// The global ladder: "active" is a reachable step only when some
				// folder has pinned rows — applied to a set with none, it renders
				// folded everywhere and the click would do nothing visible.
				const ladder: FolderFoldState[] = projectIds.some((id) => hasActiveById[id])
					? ["folded", "active", "open"]
					: ["folded", "open"];
				const maxRank = Math.max(...projectIds.map((id) => FOLD_RANK[effective(id)]));
				// Strictly above every folder's current state — so the click always
				// changes every folder (a lowest-state target can dead-lock when the
				// lowest folder cannot render the next step) — wrapping at the top.
				const target = ladder.find((st) => FOLD_RANK[st] > maxRank) ?? "folded";
				const next = { ...s };
				for (const id of projectIds) next[id] = target;
				return next;
			});
		},
		[projectIds],
	);

	useEffect(() => {
		try {
			localStorage.setItem(LS_FOLDERS_KEY, JSON.stringify(folds));
		} catch {
			/* ignore */
		}
	}, [folds]);

	return { folds, cycleFolder, cycleAllFolders };
}
