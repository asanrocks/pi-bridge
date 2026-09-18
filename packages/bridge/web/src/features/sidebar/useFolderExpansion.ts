// ============================================================================
// useFolderExpansion — sidebar folder fold state: persisted per Project, with
// the current Project auto-expanding. Adds, never removes — a manual collapse
// stays respected.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from "react";

const LS_FOLDERS_KEY = "pi-bridge:sidebar-folders";

export function useFolderExpansion(
	/** The attached Project, or null on the Launcher. */
	currentProjectId: string | null,
	/** Open session's stem, or null on the Project home. */
	currentStem: string | null,
): {
	expanded: Set<string>;
	toggleFolder: (projectId: string) => void;
} {
	const [expanded, setExpanded] = useState<Set<string>>(() => {
		try {
			const stored = localStorage.getItem(LS_FOLDERS_KEY);
			if (stored !== null) return new Set(JSON.parse(stored) as string[]);
		} catch {
			/* ignore */
		}
		return new Set();
	});

	// Landing on a Project's home (no session attached) opens its folder — the
	// browse-this-project stance. The same holds at boot for a session URL: the
	// first non-null current Project expands even when a stem is attached —
	// first-paint context, unlike a live session switch, where unfolding is
	// noise (a pinned row is already visible regardless of folding). Adds,
	// never removes — manual collapse stays respected.
	const didBootExpandRef = useRef(false);
	useEffect(() => {
		if (currentProjectId === null) return;
		const isBoot = !didBootExpandRef.current;
		didBootExpandRef.current = true;
		if (!isBoot && currentStem !== null) return;
		setExpanded((s) => (s.has(currentProjectId) ? s : new Set(s).add(currentProjectId)));
	}, [currentProjectId, currentStem]);

	const toggleFolder = useCallback((projectId: string) => {
		setExpanded((s) => {
			const next = new Set(s);
			if (next.has(projectId)) next.delete(projectId);
			else next.add(projectId);
			return next;
		});
	}, []);

	useEffect(() => {
		try {
			localStorage.setItem(LS_FOLDERS_KEY, JSON.stringify([...expanded]));
		} catch {
			/* ignore */
		}
	}, [expanded]);

	return { expanded, toggleFolder };
}
