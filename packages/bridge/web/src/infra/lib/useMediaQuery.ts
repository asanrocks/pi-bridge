import { useEffect, useState } from "react";

/**
 * Reactive CSS media-query match. Re-resolves when the query result changes
 * (e.g. a 2-in-1 switching laptop/tablet mode). SSR-safe: defaults false when
 * window is undefined; for this Vite SPA window is always defined at runtime.
 */
export function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(() => {
		if (typeof window === "undefined") return false;
		return window.matchMedia(query).matches;
	});

	useEffect(() => {
		const mql = window.matchMedia(query);
		const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
		mql.addEventListener("change", handler);
		return () => mql.removeEventListener("change", handler);
	}, [query]);

	return matches;
}
