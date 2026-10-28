// ============================================================================
// useViewModel — the store→ViewModel projection, memoized.
//
// The ViewModel (computeViewModel) is expensive; re-running it on every store
// write (every streaming flush) would be the dominant cost in the render
// path, so it is cached behind viewModelCacheKey: structural identity
// (leafPathKey/leafStreamingKey) plus the projected status fields plus the
// non-Document inputs (currentStem — a session switch re-projects even onto
// an identical document; pullTick — lazy-pull ingests re-project; docRevision
// — the document revision published with every store write, covering
// same-id content replacements the structural keys cannot see).
// The key lives in viewmodel beside the projection, so a new Status field
// that affects the projection gets added next to the code that reads it.
//
// Selects the whole document rather than per-field slices: every flush
// replaces the document (applyReplace), and entries change on every flush
// that matters, so a field-level split cannot skip renders here — it only
// forces the caller to reassemble the Document by hand.
// ============================================================================

import { useMemo, useRef } from "react";
import type { ViewModel } from "../../../../src/viewmodel/index.ts";
import { computeViewModel, viewModelCacheKey } from "../../../../src/viewmodel/index.ts";
import { useStore } from "./store.tsx";

export function useViewModel(): ViewModel {
	const doc = useStore((s) => s.document);
	const models = useStore((s) => s.models);
	const scope = useStore((s) => s.currentStem);
	const pullTick = useStore((s) => s.pullTick);
	// Document revision: same-id content replacements are invisible to the
	// structural part of the key, so the revision is a declared input.
	const docRevision = useStore((s) => s.docRevision);
	// Rendered-leaf override (peek). `null` follows the live leaf; the key
	// includes it, so peek/un-peek over an unchanged document re-projects.
	const renderLeafId = useStore((s) => s.renderLeafId);
	// The catalogue is a projection input (context percentage is computed
	// against each model's context window), so its identity is in the key.
	const modelsKey = useMemo(
		() => models.map((m) => `${m.provider}/${m.id}:${m.contextWindow ?? 0}`).join(","),
		[models],
	);

	const cacheRef = useRef<{ key: string; vm: ViewModel } | null>(null);
	return useMemo(() => {
		const key = viewModelCacheKey(doc, scope, pullTick, renderLeafId, modelsKey, docRevision);
		if (cacheRef.current?.key === key) {
			return cacheRef.current.vm;
		}
		// Identity preservation (ADR 07 invariant 3c): computeViewModel reuses
		// unchanged TurnVM/block references from the previous VM, so memo'd
		// children skip re-render on irrelevant recomputations. The previous VM
		// may be the live projection while peeking (or vice versa) — shared
		// prefix turns are reused across the switch, which is the point.
		const prevVm = cacheRef.current?.vm;
		const vm = computeViewModel({ document: doc, models, viewLeafId: renderLeafId }, prevVm);
		cacheRef.current = { key, vm };
		return vm;
	}, [doc, models, scope, pullTick, docRevision, renderLeafId, modelsKey]);
}
