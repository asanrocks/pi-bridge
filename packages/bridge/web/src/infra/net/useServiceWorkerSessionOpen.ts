// ============================================================================
// useServiceWorkerSessionOpen — the service worker's click-through handoff.
//
// A completion notification names a Session. Its click either opens a new tab
// on that address (the worker does that itself when no client is visible) or
// messages the client that is already open, which must then navigate through
// the same open intent a click in the switcher uses — never by writing the
// route, which the navigation actor owns (ADR 19).
//
// The message payload is a trust boundary: it arrives from a non-React event
// with no type, so its shape is checked before it names an address.
// ============================================================================

import { useEffect } from "react";

export function useServiceWorkerSessionOpen(openSession: (projectId: string, stem: string) => void): void {
	useEffect(() => {
		if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
		const onMessage = (event: MessageEvent) => {
			const data: unknown = event.data;
			if (data === null || typeof data !== "object") return;
			const message = data as { type?: unknown; projectId?: unknown; stem?: unknown };
			if (message.type !== "open-session") return;
			if (typeof message.projectId !== "string" || typeof message.stem !== "string") return;
			openSession(message.projectId, message.stem);
		};
		navigator.serviceWorker.addEventListener("message", onMessage);
		return () => navigator.serviceWorker.removeEventListener("message", onMessage);
	}, [openSession]);
}
