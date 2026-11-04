// ============================================================================
// pinnedEdit — the picker's pure edits of the daemon-global pinned list.
//
// The wire carries the whole ordered list (ADR 20), so pinning, unpinning, and
// reordering are splices here rather than operations the host interprets. That
// makes the picker's intent testable without a browser and keeps the host to
// one job: filter what the catalogue cannot resolve, write the order, announce
// the result.
//
// The picker keeps its own copy of the list for its lifetime, seeded at open, so
// a pin cannot move a row under the cursor. Every edit is a splice of that copy
// and the copy is what goes on the wire: a concurrent edit from another client
// is last-writer-wins (ADR 20), which is a documented window rather than
// something a half-reconciled copy should paper over.
// ============================================================================

import type { PinnedModelSelection } from "../../../../src/core/index.ts";

/** The shape a picker row contributes: the pinned entries carry a level, the
 * catalogue rows do not, and a reorder must not need to know which it holds. */
interface PinnedLike {
	provider: string;
	id: string;
	thinkingLevel?: string;
}

function keyOf(entry: { provider: string; id: string }): string {
	return `${entry.provider}/${entry.id}`;
}

/** The wire shape of one pinned entry, level included — the level is
 * round-tripped verbatim so an edit never silently changes what a pin means. */
export function pinnedSelectionOf(model: PinnedLike): PinnedModelSelection {
	return model.thinkingLevel === undefined
		? { provider: model.provider, id: model.id }
		: { provider: model.provider, id: model.id, thinkingLevel: model.thinkingLevel };
}

export function pinnedSelectionsOf(models: PinnedLike[]): PinnedModelSelection[] {
	return models.map(pinnedSelectionOf);
}

/** Pin (append to the tail — a new pin never becomes the default) or unpin.
 * Pinning an identity that is already in the list re-appends the target as
 * passed, so a caller that omits the level drops the level the list held —
 * unreachable through the picker (it derives `pinned` from the same list, so
 * a pinned row always unpins), but the helper promises identity idempotency,
 * not level idempotency. */
export function withPinned(
	list: PinnedModelSelection[],
	target: PinnedModelSelection,
	pinned: boolean,
): PinnedModelSelection[] {
	const without = list.filter((entry) => keyOf(entry) !== keyOf(target));
	return pinned ? [...without, target] : without;
}

/** The list with entry `from` moved to index `to` (an index in the result). */
export function movePinnedEntry(list: PinnedModelSelection[], from: number, to: number): PinnedModelSelection[] {
	const bounded = Math.max(0, Math.min(to, list.length - 1));
	if (from === bounded || from < 0 || from >= list.length) return list;
	const next = [...list];
	const [moved] = next.splice(from, 1);
	next.splice(bounded, 0, moved);
	return next;
}
