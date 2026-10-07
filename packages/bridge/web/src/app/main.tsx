import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initZoom, installZoomGestures } from "../infra/lib/zoom.ts";
import { App } from "./App.tsx";
import "./index.css";

// Apply the persisted display scale before the first paint so a stored step
// does not flash at 100% first.
initZoom();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);

// Pinch-to-step-zoom and double-tap-to-reset, plus the trackpad-pinch block.
// See infra/lib/zoom.ts.
installZoomGestures();

// Service worker: the vehicle for turn-completion notifications (see
// app/useStatusNotifications.ts) and the offline app shell (navigations
// network-first with a cached-shell fallback; /assets/* cache-first). The
// vite dev server is unaffected: it serves no /assets/* paths and
// network-first navigations pass through while it is up. Registration is
// secure-context-only (localhost counts) and failure is non-fatal — the
// document Notification() constructor remains the fallback.
if ("serviceWorker" in navigator) {
	navigator.serviceWorker.register("/sw.js").catch(() => {});
}
