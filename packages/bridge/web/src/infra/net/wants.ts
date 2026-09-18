// ============================================================================
// Wants outbox (ADR 09) — a write-only channel from render to the pull loop.
// Components append the lazy-field paths they need while rendering; the
// connection layer drains the outbox (microtask-scheduled) and issues one
// batched pull. Appends are idempotent: duplicates and already-populated
// fields are filtered by planPull; extra wants from discarded concurrent
// renders cost at most one redundant pull of already-fetched data.
// ============================================================================

import type { PullRequestItem } from "../../../../src/core/index.ts";

const outbox: PullRequestItem[] = [];
let drainer: (() => void) | null = null;
let scheduled = false;

function scheduleDrain(): void {
	if (scheduled || !drainer) return;
	scheduled = true;
	queueMicrotask(() => {
		scheduled = false;
		drainer?.();
	});
}

/** Append wants during render. Schedules a drain after the current task. */
export function wantPull(items: PullRequestItem[]): void {
	if (items.length === 0) return;
	outbox.push(...items);
	scheduleDrain();
}

/** Drain the outbox: returns all accumulated wants and clears it. */
export function takeWants(): PullRequestItem[] {
	return outbox.splice(0, outbox.length);
}

/** Register the drain callback (the pull loop). Pass null to detach. */
export function setWantsDrainer(fn: (() => void) | null): void {
	drainer = fn;
	if (outbox.length > 0) scheduleDrain();
}
