// ============================================================================
// useModelCycling — the model cycle shared by the composer's picker (its
// cycle button) and the Ctrl+P / Ctrl+Shift+P keybinding. Pinned models win
// when present; otherwise one representative per provider (the first seen).
// Lives here, not in App, so both callers are identical by construction.
//
// The cycle writes the local selection pick (the stateless client API): there
// is no model verb to call, and the next send carries the cycled model.
// ============================================================================

import { useCallback, useMemo } from "react";
import { findNextModel } from "../../../../src/viewmodel/index.ts";
import { useStore } from "../../infra/state/store.tsx";
import { useNextSelection } from "./useNextSelection.ts";

export function useModelCycling(): (direction: "forward" | "backward") => void {
	const models = useStore((s) => s.models);
	const pinnedModels = useStore((s) => s.pinnedModels);
	const setSelectionPick = useStore((s) => s.setSelectionPick);

	const cycleModels = useMemo(() => {
		if (pinnedModels.length > 0) return pinnedModels;
		const seen = new Set<string>();
		return models.filter((m) => {
			if (seen.has(m.provider)) return false;
			seen.add(m.provider);
			return true;
		});
	}, [pinnedModels, models]);

	// The cycle's base is what the picker shows — the pick else the path
	// inheritance — so cycling from an inherited model starts at its slot.
	const selection = useNextSelection();

	return useCallback(
		(direction: "forward" | "backward") => {
			const current = selection.model ?? undefined;
			const next = findNextModel(cycleModels, current ?? { provider: "", modelId: "" }, direction);
			if (next && !(current && next.provider === current.provider && next.id === current.modelId)) {
				setSelectionPick({ model: { provider: next.provider, modelId: next.id }, thinkingLevel: null });
			}
		},
		[cycleModels, selection.model, setSelectionPick],
	);
}
