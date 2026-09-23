// ============================================================================
// useModelCycling — the model cycle shared by the composer's picker (its
// cycle button) and the Ctrl+P / Ctrl+Shift+P keybinding. Pinned models win
// when present; otherwise one representative per provider (the first seen).
// Lives here, not in App, so both callers are identical by construction.
// ============================================================================

import { useCallback, useMemo } from "react";
import { findNextModel } from "../../../../src/viewmodel/index.ts";
import { useRpc } from "../../infra/net/useRpc.ts";
import { useStore } from "../../infra/state/store.tsx";

export function useModelCycling(): (direction: "forward" | "backward") => void {
	const models = useStore((s) => s.models);
	const pinnedModels = useStore((s) => s.pinnedModels);
	const statusModel = useStore((s) => s.document.status.model);
	const rpc = useRpc();

	const cycleModels = useMemo(() => {
		if (pinnedModels.length > 0) return pinnedModels;
		const seen = new Set<string>();
		return models.filter((m) => {
			if (seen.has(m.provider)) return false;
			seen.add(m.provider);
			return true;
		});
	}, [pinnedModels, models]);

	return useCallback(
		(direction: "forward" | "backward") => {
			const next = findNextModel(cycleModels, statusModel, direction);
			if (next) rpc.setModel(next.provider, next.id);
		},
		[cycleModels, statusModel, rpc],
	);
}
