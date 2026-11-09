// ============================================================================
// useFolderExpansion — the Sidebar's folder state: React state plus the
// `localStorage` record, over the pure algebra in foldState.ts. A folder starts
// unfolded at the attention floor (Inbox, or Later when it has none), which is
// both where leftover work is picked up and the cheapest state: no archived
// page is requested until Load more reaches the cap.
// ============================================================================

import { useCallback, useEffect, useState } from "react";
import {
	advanceReveal,
	DEFAULT_FOLDER_STATE,
	effectiveReveal,
	type FolderState,
	foldAllTarget,
	migrateFoldRecord,
	retreatReveal,
	toggleFolded,
} from "./foldState.ts";

const LS_FOLDERS_KEY = "pi-bridge:sidebar-folders";

export type { FolderReveal, FolderState } from "./foldState.ts";

export function useFolderExpansion(
	/** All configured Project ids — the fan-out target of the header toggle. */
	projectIds: string[],
): {
	folders: Record<string, FolderState>;
	/** The folder heading: fold or unfold, keeping the reveal. */
	toggleFolder: (projectId: string) => void;
	/** Load more: the next reveal step (the caller paginates at the cap). */
	advanceFolder: (projectId: string, hasInbox: boolean, hasLater: boolean) => void;
	/** Show less: the previous reveal step, never below the floor. */
	retreatFolder: (projectId: string, hasInbox: boolean, hasLater: boolean) => void;
	/** The Projects header: fold everything, or unfold everything. */
	toggleAllFolders: () => void;
} {
	const [folders, setFolders] = useState<Record<string, FolderState>>(() => {
		try {
			const stored = localStorage.getItem(LS_FOLDERS_KEY);
			if (stored !== null) return migrateFoldRecord(JSON.parse(stored));
		} catch {
			/* ignore */
		}
		return {};
	});

	const updateFolder = useCallback((projectId: string, update: (state: FolderState) => FolderState) => {
		setFolders((s) => ({ ...s, [projectId]: update(s[projectId] ?? DEFAULT_FOLDER_STATE) }));
	}, []);

	// Landing on a Project does not change its reveal: an unvisited folder is
	// already unfolded at the floor, and a manual fold survives a restart. Only
	// the reveal's own controls move the ladder.

	const toggleFolder = useCallback(
		(projectId: string) => {
			updateFolder(projectId, toggleFolded);
		},
		[updateFolder],
	);

	const advanceFolder = useCallback(
		(projectId: string, hasInbox: boolean, hasLater: boolean) => {
			updateFolder(projectId, (state) => ({
				...state,
				// From the rendered step, not the stored one: a remembered reveal below
				// the floor would otherwise advance to the step it already renders.
				reveal: advanceReveal(effectiveReveal(state.reveal, hasInbox, hasLater), hasLater),
			}));
		},
		[updateFolder],
	);

	const retreatFolder = useCallback(
		(projectId: string, hasInbox: boolean, hasLater: boolean) => {
			updateFolder(projectId, (state) => ({
				...state,
				reveal: retreatReveal(effectiveReveal(state.reveal, hasInbox, hasLater), hasInbox, hasLater),
			}));
		},
		[updateFolder],
	);

	const toggleAllFolders = useCallback(() => {
		setFolders((s) => {
			if (projectIds.length === 0) return s;
			const folded = foldAllTarget(projectIds.map((id) => s[id] ?? DEFAULT_FOLDER_STATE));
			const next = { ...s };
			for (const id of projectIds) next[id] = { folded, reveal: (s[id] ?? DEFAULT_FOLDER_STATE).reveal };
			return next;
		});
	}, [projectIds]);

	useEffect(() => {
		try {
			localStorage.setItem(LS_FOLDERS_KEY, JSON.stringify(folders));
		} catch {
			/* ignore */
		}
	}, [folders]);

	return { folders, toggleFolder, advanceFolder, retreatFolder, toggleAllFolders };
}
