// useNow — a wall-clock value that ticks while `active` is true and freezes
// otherwise. Drives the live "working for Xs" total on the in-flight
// assistant turn: the tick re-renders the (memoized) streaming turn once per
// second so `Date.now() - turn.turnStartedAt` stays fresh even when no
// content delta arrives (e.g. a long-running tool with no streaming output).
// Sealed turns pass `active === false`, so the interval never starts and the
// hook is inert for them.

import { useEffect, useState } from "react";

const TICK_MS = 1000;

export function useNow(active: boolean): number {
	const [now, setNow] = useState<number>(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const id = setInterval(() => setNow(Date.now()), TICK_MS);
		return () => clearInterval(id);
	}, [active]);
	return now;
}
