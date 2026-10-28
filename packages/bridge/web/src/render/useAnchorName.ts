// ============================================================================
// useAnchorName — the one piece of JavaScript CSS anchor positioning needs.
//
// A popover's CSS resolves `anchor(bottom)`, `anchor(inline-start)`, … from a
// name, and the name lives on the trigger. So the trigger carries it while the
// popover exists and drops it afterwards (anchor names are document-global; one
// popover per name is enough, and one is open at a time). Everything the old
// `DOMRect` snapshot did — the flip, the viewport clamp, the stale-rect-after-
// scroll bug — is the platform's job now.
//
// Setting a custom property from a component is the documented dynamic-value
// exception in the styling-token boundary: there is no stylesheet that could
// know which element is about to be a trigger.
//
// `useLayoutEffect`, not `useEffect`: the panel is already in the tree when this
// runs, and a paint without the anchor would show it at its static position for
// one frame.
// ============================================================================

import { useLayoutEffect } from "react";

export function useAnchorName(element: HTMLElement | null, name: string): void {
	useLayoutEffect(() => {
		if (element === null) return;
		element.style.setProperty("anchor-name", name);
		return () => {
			element.style.removeProperty("anchor-name");
		};
	}, [element, name]);
}
