// ============================================================================
// useNow — the clock behind every rendered label. Labels are relative, so
// they go stale unless something re-renders them: a memoized row that reads
// Date.now() during render freezes at whatever it said when it last rendered.
//
// One module-level interval feeds every subscriber, so a sidebar with hundreds
// of rows costs one timer, and every label on screen agrees on `now`. The
// interval runs only while something is subscribed. A backgrounded tab
// throttles timers (labels can be minutes stale on return), so becoming
// visible re-samples immediately instead of waiting for the next tick.
// ============================================================================

import { useSyncExternalStore } from "react";

const TICK_MS = 60_000;

const listeners = new Set<() => void>();
let now = Date.now();
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
		timer = setInterval(tick, TICK_MS);
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

const getSnapshot = (): number => now;
// Server render (and the SSR component tests): a fixed reading, no timer.
const getServerSnapshot = (): number => now;

export function useNow(): number {
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
