// useDetailsCap — the height-cap + clipped-fade mechanics for a card's
// details panel, shared by tool cards (ToolActionView) and user-bash
// cards (UserBashView). Detects whether the capped panel's content
// overflows and whether the scroll window sits at the content tail (the
// fade must never claim hidden content once the user scrolled to the
// bottom). Cap state (uncapped) lives in the store keyed by the same
// `${entryId}:b${blockIndex}` format the tool actions use.

import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../../../infra/state/store.tsx";

export type DetailsCap = "none" | "capped" | "uncapped";

export function useDetailsCap(actionKey: string, active: boolean) {
	const isUncapped = useStore(useCallback((s) => s.uncappedDetails.has(actionKey), [actionKey]));
	const toggleUncap = useStore((s) => s.toggleUncapDetails);

	const cardRef = useRef<HTMLDivElement>(null);
	const [isClipped, setIsClipped] = useState(false);
	const [atTail, setAtTail] = useState(true);

	useEffect(() => {
		const el = cardRef.current;
		if (!el || !active || isUncapped) {
			setIsClipped(false);
			setAtTail(true);
			return;
		}
		const check = () => {
			setIsClipped(el.scrollHeight > el.clientHeight + 1);
			setAtTail(el.scrollTop + el.clientHeight >= el.scrollHeight - 1);
		};
		check();
		const ro = new ResizeObserver(check);
		ro.observe(el);
		el.addEventListener("scroll", check, { passive: true });
		return () => {
			ro.disconnect();
			el.removeEventListener("scroll", check);
		};
	}, [active, isUncapped]);

	const capped: DetailsCap = active ? (isUncapped ? "uncapped" : isClipped ? "capped" : "none") : "none";
	return { isUncapped, toggleUncap, atTail, capped, cardRef };
}
