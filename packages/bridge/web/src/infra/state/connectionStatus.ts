// ============================================================================
// connectionStatus — the single source of truth for connection-state wording
// and visible state. Both down-state surfaces consume it: the TopBar icon
// (phase + tone drive shape, hue, and motion; the text lives in tooltip and
// aria-label only) and the Launcher full panel (label + detail + retry).
// No other module phrases connection state.
//
// The visible model collapses four internal states to two:
//   trying = a retry loop is running (animated icon, motion ≈ reaching)
//   failed = nothing is retrying (still icon)
// ============================================================================

import type { ConnectionState } from "./store.ts";

export interface ConnectionStatus {
	/** Short label — the panel title and the icon's aria-label. */
	label: string;
	/** Fuller explanation — the panel sub-line and the icon tooltip. */
	detail: string;
	/** trying = animated icon; failed = still icon. */
	phase: "trying" | "failed";
	/** Hue carrier: muted while reaching the daemon for the first time,
	 *  err once the connection dropped or the daemon misbehaved. Also picks
	 *  the animation rhythm (slow while muted, fast while err). */
	tone: "muted" | "err";
}

/** Null when connected (no affordance rendered). */
export function connectionStatus(state: ConnectionState): ConnectionStatus | null {
	switch (state.kind) {
		case "connected":
			return null;
		case "connecting":
			return {
				label: "Connecting…",
				detail: "Connecting to the daemon",
				phase: "trying",
				tone: "muted",
			};
		case "reconnecting":
			return {
				label: "Reconnecting…",
				detail: `Connection dropped — retrying (attempt ${state.attempt})`,
				phase: "trying",
				tone: "err",
			};
		case "unreachable":
			return {
				label: "Can't reach pi-bridge",
				detail: "pi-bridge isn't running, or the connection was dropped — retrying",
				phase: "trying",
				tone: "err",
			};
		case "init_failed":
			return {
				label: "Daemon unresponsive",
				detail: state.error || "Connected, but the server didn't respond",
				phase: "failed",
				tone: "err",
			};
	}
}
