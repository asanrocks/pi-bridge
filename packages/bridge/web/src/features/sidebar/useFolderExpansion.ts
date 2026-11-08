// ============================================================================
// useFolderExpansion — the Sidebar's fold state: React state plus the
// `localStorage` record, over the pure algebra in foldState.ts. Defaults to
// `inbox` (the attention list, without Later or history) and adds, never
// removes — a manual fold stays respected.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { type FolderFoldState, foldAllTarget, migrateFoldRecord, nextFoldState } from "./foldState.ts";

const LS_FOLDERS_KEY = "pi-bridge:sidebar-folders";

export type { FolderFoldState };

export function useFolderExpansion(
	/** All configured Project ids — the fan-out target of the header toggle. */
	projectIds: string[],
	/** The attached Project, or null on the Launcher. */
	currentProjectId: string | null,
	/** Open session's stem, or null on the Project home. */
	currentStem: string | null,
): {
	folds: Record<string, FolderFoldState>;
	cycleFolder: (projectId: string, hasInbox: boolean) => void;
	/** The Projects header: apply one uniform fold state to every folder. */
	cycleAllFolders: (hasInboxById: Record<string, boolean>) => void;
} {
	const [folds, setFolds] = useState<Record<string, FolderFoldState>>(() => {
		try {
			const stored = localStorage.getItem(LS_FOLDERS_KEY);
			if (stored !== null) return migrateFoldRecord(JSON.parse(stored));
		} catch {
			/* ignore */
		}
		return {};
	});

	// Landing on a Project's home (no session attached) opens its folder — the
	// browse-this-project stance. The same holds at boot for a session URL: the
	// first non-null current Project opens even when a stem is attached —
	// first-paint context, unlike a live session switch, where unfolding is
	// noise (an Inbox row is already visible regardless of folding). Adds,
	// never removes — a manual fold stays respected.
	const didBootExpandRef = useRef(false);
	useEffect(() => {
		if (currentProjectId === null) return;
		const isBoot = !didBootExpandRef.current;
		didBootExpandRef.current = true;
		if (!isBoot && currentStem !== null) return;
		setFolds((s) => (s[currentProjectId] === "all" ? s : { ...s, [currentProjectId]: "all" }));
	}, [currentProjectId, currentStem]);

	const cycleFolder = useCallback((projectId: string, hasInbox: boolean) => {
		setFolds((s) => ({ ...s, [projectId]: nextFoldState(s[projectId] ?? "inbox", hasInbox) }));
	}, []);

	const cycleAllFolders = useCallback(
		(hasInboxById: Record<string, boolean>) => {
			setFolds((s) => {
				if (projectIds.length === 0) return s;
				const target = foldAllTarget(s, projectIds, hasInboxById);
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
