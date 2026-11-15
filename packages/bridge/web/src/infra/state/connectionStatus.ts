// ============================================================================
// connectionStatus — the single source of truth for connection-state wording
// and visible state. Both down-state surfaces consume it: the TopBar icon
// (shape, hue, motion; the text lives in tooltip and aria-label only) and the
// Launcher full panel (label + detail + one action). No other module phrases
// connection state, and no other module decides what the state's remedy is.
//
// The visible model collapses the internal states to two phases:
//   trying = a retry loop is running (animated icon, motion ≈ reaching)
//   failed = nothing is retrying (still icon)
// A build mismatch is the exception the `blink` flag exists for: it is a still
// state — nothing retries, because no retry can change either build — that
// demands the user's action, so its icon pulses in the amber attention rhythm.
// ============================================================================

import { buildLabel } from "../../../../src/core/index.ts";
import type { ConnectionState } from "./store.ts";

/** The one gesture a state offers. `retry` reconnects; `reload-app` replaces
 * this app with the copy the Daemon serves, which is the only side a page can
 * replace. */
export type ConnectionAction = "retry" | "reload-app";

export interface ConnectionStatus {
	/** Short label — the panel title and the icon's aria-label. */
	label: string;
	/** Fuller explanation — the panel sub-line and the icon tooltip. */
	detail: string;
	/** trying = animated icon; failed = still icon. */
	phase: "trying" | "failed";
	/** Hue carrier: muted while reaching the daemon for the first time,
	 *  err once the connection dropped or the daemon misbehaved, warn for a build
	 *  mismatch (a deployment problem, not a network one). Also picks
	 *  the animation rhythm (slow while muted, fast while err). */
	tone: "muted" | "err" | "warn";
	/** Attention motion for a still state that needs the user. */
	blink: boolean;
	/** Null while there is nothing to click (a first connection attempt). */
	action: ConnectionAction | null;
	actionLabel: string | null;
	/** The state retries by itself, so the panel says so. */
	autoRetry: boolean;
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
				blink: false,
				action: null,
				actionLabel: null,
				autoRetry: false,
			};
		case "reconnecting":
			return {
				label: "Reconnecting…",
				detail: `Connection dropped — retrying (attempt ${state.attempt})`,
				phase: "trying",
				tone: "err",
				blink: false,
				action: "retry",
				actionLabel: "Retry now",
				autoRetry: true,
			};
		case "unreachable":
			return {
				label: "Can't reach pi-bridge",
				detail: "pi-bridge isn't running, or the connection was dropped — retrying",
				phase: "trying",
				tone: "err",
				blink: false,
				action: "retry",
				actionLabel: "Retry now",
				autoRetry: true,
			};
		case "init_failed":
			return {
				label: "Daemon unresponsive",
				detail: state.error || "Connected, but the server didn't respond",
				phase: "failed",
				tone: "err",
				blink: false,
				action: "retry",
				actionLabel: "Retry now",
				autoRetry: false,
			};
		case "build_mismatch":
			// One state, one remedy: the Daemon serves the app, so a reload takes the
			// copy it serves. `retried` is the stuck case — this document already
			// reloaded into that very build and still disagrees, which means the assets
			// on disk are not the running process's build.
			return {
				label: state.retried ? "Builds disagree" : "App out of date",
				detail: state.retried
					? `This app is ${buildLabel(state.app)}; the daemon is ${
							state.daemon === null ? "an older build with no stamp" : buildLabel(state.daemon)
						}. Reloading did not pick up the daemon's build — restart pi-bridge on the host.`
					: `This app is ${buildLabel(state.app)}; the daemon is ${
							state.daemon === null ? "an older build with no stamp" : buildLabel(state.daemon)
						}. Reload to take the app the daemon serves.`,
				phase: "failed",
				tone: "warn",
				blink: true,
				action: "reload-app",
				actionLabel: "Reload page",
				autoRetry: false,
			};
	}
}
