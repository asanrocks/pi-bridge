// ============================================================================
// useNow — the clocks behind every rendered label. Labels are relative or
// durations, so they go stale unless something re-renders them: a memoized row
// that reads Date.now() during render freezes at whatever it said when it last
// rendered.
//
// Two cadences share one implementation. The minute clock is the default:
// recency labels change in minutes, so re-rendering a sidebar of hundreds of
// rows every second would buy nothing. The second clock belongs to a live
// duration — a running row's elapsed time — and is a separate store so that
// only the rows showing one pay the fast tick.
//
// Each store feeds every subscriber through one module-level interval, so a
// sidebar with hundreds of rows costs one timer per cadence in use, and every
// label on screen agrees on `now`. An interval runs only while something is
// subscribed. A backgrounded tab throttles timers (labels can be minutes stale
// on return), so becoming visible re-samples immediately instead of waiting for
// the next tick.
// ============================================================================

import { useSyncExternalStore } from "react";

const MINUTE_MS = 60_000;
const SECOND_MS = 1_000;

interface Clock {
	subscribe: (listener: () => void) => () => void;
	getSnapshot: () => number;
}

function createClock(tickMs: number): Clock {
	let now = Date.now();
	const listeners = new Set<() => void>();
	let timer: ReturnType<typeof setInterval> | null = null;

	function tick(): void {
		now = Date.now();
		for (const listener of listeners) listener();
	}

	function onVisibilityChange(): void {
		if (!document.hidden) tick();
	}

	function subscribe(listener: () => void): () => void {
		listeners.add(listener);
		if (timer === null) {
			timer = setInterval(tick, tickMs);
			document.addEventListener("visibilitychange", onVisibilityChange);
		}
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0 && timer !== null) {
				clearInterval(timer);
				timer = null;
				document.removeEventListener("visibilitychange", onVisibilityChange);
			}
		};
	}

	return { subscribe, getSnapshot: () => now };
}

const minuteClock = createClock(MINUTE_MS);
const secondClock = createClock(SECOND_MS);

/** The shared minute clock: what a recency label needs. */
export function useNow(): number {
	return useSyncExternalStore(minuteClock.subscribe, minuteClock.getSnapshot, minuteClock.getSnapshot);
}

/** The clock for one row's live duration: the second clock while `live` (a run
 * counts seconds), the minute clock otherwise. Switching stores re-subscribes,
 * so only the rows showing a live duration pay the fast tick. */
export function useLabelClock(live: boolean): number {
	const clock = live ? secondClock : minuteClock;
	return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
}
