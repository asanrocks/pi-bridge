// ============================================================================
// useTurnClock — seconds-granularity wall clock for the in-flight turn's
// header span ("working for 12s"). Distinct from infra/lib/useNow, which is
// the label clock (one shared minute tick): a live span must refresh every
// second, and only one turn streams at a time, so an interval per active turn
// is the cheapest correct thing. Sealed turns pass `active === false`, so the
// hook is inert and starts no timer.
// ============================================================================

import { useEffect, useState } from "react";

const TICK_MS = 1000;

export function useTurnClock(active: boolean): number {
	const [now, setNow] = useState<number>(() => Date.now());
	useEffect(() => {
		if (!active) return;
		// Re-sample on activation so the first paint after a remount is not
		// anchored on a stale reading from a previous mount.
		setNow(Date.now());
		const id = setInterval(() => setNow(Date.now()), TICK_MS);
		return () => clearInterval(id);
	}, [active]);
	return now;
}
