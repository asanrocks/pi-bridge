// ============================================================================
// Pull queue (ADR 09) — a write-only channel from render to the pull loop.
// Components enqueue the lazy-field paths they need while rendering; the
// connection layer drains the queue (microtask-scheduled) and issues one
// batched pull. Appends are idempotent: duplicates and already-populated
// fields are filtered by planPull; extra requests from discarded concurrent
// renders cost at most one redundant pull of already-fetched data.
// ============================================================================

import type { PullRequestItem } from "../../../../src/core/index.ts";

const queue: PullRequestItem[] = [];
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

/** Enqueue pending pulls during render. Schedules a drain after the current task. */
export function enqueuePulls(items: PullRequestItem[]): void {
	if (items.length === 0) return;
	queue.push(...items);
	scheduleDrain();
}

/** Drain the queue: returns all accumulated pending pulls and clears it. */
export function drainPullQueue(): PullRequestItem[] {
	return queue.splice(0, queue.length);
}

/** Register the drain callback (the pull loop). Pass null to detach. */
export function setDrainer(fn: (() => void) | null): void {
	drainer = fn;
	if (queue.length > 0) scheduleDrain();
}
