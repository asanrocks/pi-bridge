import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);

// Trackpad pinch arrives as synthetic wheel events with ctrlKey: true
// (Windows Precision Touchpad, macOS Chrome/Edge/Firefox) or as non-standard
// gesture events (Safari on macOS); the browser zooms the page in both cases.
// touch-action cannot intercept either path (wheel/gesture, not touch
// pointers), so block both here. Keyboard zoom (ctrl +/-/0) and the browser
// zoom menu are untouched — only gesture-driven zoom is prevented.
// passive: false is required on wheel or the browser ignores preventDefault.
window.addEventListener(
	"wheel",
	(e) => {
		if (e.ctrlKey) e.preventDefault();
	},
	{ passive: false },
);
window.addEventListener("gesturestart", (e) => e.preventDefault());
window.addEventListener("gesturechange", (e) => e.preventDefault());

// Service worker: the vehicle for turn-completion notifications (see
// app/useStatusNotifications.ts). It has no fetch handler, so it never
// caches or intercepts requests. Registration is secure-context-only
// (localhost counts) and failure is non-fatal — the document
// Notification() constructor remains the fallback.
if ("serviceWorker" in navigator) {
	navigator.serviceWorker.register("/sw.js").catch(() => {});
}
