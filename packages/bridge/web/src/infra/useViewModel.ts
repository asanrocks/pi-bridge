// ============================================================================
// useViewModel — the store→ViewModel projection, memoized.
//
// The ViewModel (computeViewModel) is expensive; re-running it on every store
// write (every streaming flush) would be the dominant cost in the render
// path, so it is cached behind viewModelCacheKey: structural identity
// (leafPathKey/leafStreamingKey) plus the projected status fields plus the
// two non-Document inputs (currentStem — a session switch re-projects even
// onto an identical document — and pullTick — lazy-pull ingests re-project).
// The key lives in viewmodel beside the projection, so a new Status field
// that affects the projection gets added next to the code that reads it.
//
// Selects the whole document rather than per-field slices: every flush
// replaces the document (applyReplace), and entries change on every flush
// that matters, so a field-level split cannot skip renders here — it only
// forces the caller to reassemble the Document by hand.
// ============================================================================

import { useMemo, useRef } from "react";
import type { ViewModel } from "../../../src/viewmodel/index.ts";
import { computeViewModel, viewModelCacheKey } from "../../../src/viewmodel/index.ts";
import { useStore } from "./store.tsx";

export function useViewModel(): ViewModel {
	const doc = useStore((s) => s.document);
	const models = useStore((s) => s.models);
	const scope = useStore((s) => s.currentStem);
	const pullTick = useStore((s) => s.pullTick);

	const cacheRef = useRef<{ key: string; vm: ViewModel } | null>(null);
	return useMemo(() => {
		const key = viewModelCacheKey(doc, scope, pullTick);
		if (cacheRef.current?.key === key) {
			return cacheRef.current.vm;
		}
		// Identity preservation (ADR 07 invariant 3c): computeViewModel reuses
		// unchanged TurnVM/block references from the previous VM, so memo'd
		// children skip re-render on irrelevant recomputations.
		const prevVm = cacheRef.current?.vm;
		const vm = computeViewModel({ document: doc, models }, prevVm);
		cacheRef.current = { key, vm };
		return vm;
	}, [doc, models, scope, pullTick]);
}
