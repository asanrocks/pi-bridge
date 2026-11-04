// ============================================================================
// useNextSelection — the store binding for nextSelectionOf.
//
// The composer surfaces are memo'd and render per keystroke, not per streaming
// patch: the Document's identity changes on every patch, so subscribing it
// would re-render the dock (and, through the fresh objects the heuristic
// returns, defeat ComposeCard's memo) once per token. The selector therefore
// recomputes on every store write — an O(path depth) walk, the same class as
// the store's other derived selectors — and hands back the previous object
// whenever the *values* are unchanged, which is what zustand's identity
// comparison sees.
//
// Value identity is the whole selection: the display model, the carried model,
// the level, and the carried level. A change in any of them is a change worth
// rendering; a streaming delta that moves none of them is not.
// ============================================================================

import type { ClientStore } from "../../infra/state/store.ts";
import { useStore } from "../../infra/state/store.tsx";
import { type NextSelection, nextSelectionOf } from "./nextSelection.ts";

function selectionKey(selection: NextSelection): string {
	const model = selection.model ? `${selection.model.provider}/${selection.model.modelId}` : "";
	const carry = selection.carryModel ? `${selection.carryModel.provider}/${selection.carryModel.modelId}` : "";
	return `${model}\u0000${carry}\u0000${selection.level}\u0000${selection.carryLevel ?? ""}`;
}

/** One store, so one slot: two subscribers asking the same question share the
 * identity that lets both skip the render. */
let cached: { key: string; value: NextSelection } | null = null;

function selectNextSelection(state: ClientStore): NextSelection {
	const value = nextSelectionOf({
		document: state.document,
		draft: state.draft,
		pick: state.selectionPick,
		models: state.models,
	});
	const key = selectionKey(value);
	if (cached !== null && cached.key === key) return cached.value;
	cached = { key, value };
	return value;
}

export function useNextSelection(): NextSelection {
	return useStore(selectNextSelection);
}
