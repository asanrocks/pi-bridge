// ============================================================================
// useHistoryPaneShell — the HistoryPane's container hook, mirroring
// useSidebarShell: owns the tri-mode state (usePaneMode — here rather than in
// the pane so it survives the pane's unmount when no session is open) and the
// raw TopBar hover signal, and composes the presentational pane (the graph
// body reads the store itself). App consumes { pane, mode, toggle,
// setHistoryHover }.
// ============================================================================

import { useCallback, useRef, useState } from "react";
import { useMediaQuery } from "../../infra/lib/useMediaQuery.ts";
import { usePaneMode } from "../../render/usePaneMode.ts";
import { HistoryPane } from "./HistoryPane.tsx";

const HISTORY_BREAKPOINT = "(min-width: 768px)";

export function useHistoryPaneShell() {
	const isWide = useMediaQuery(HISTORY_BREAKPOINT);
	const [historyHover, setHistoryHover] = useState(false);
	const toggleRef = useRef<() => void>(() => {});
	const { mode, setMode } = usePaneMode({
		isWide,
		persistenceKey: "pi-bridge:history-open",
		toggleRef,
	});

	const pane = <HistoryPane isWide={isWide} mode={mode} setMode={setMode} historyHover={historyHover} />;
	const toggle = useCallback(() => toggleRef.current(), []);

	return { pane, mode, toggle, setHistoryHover };
}
