// ============================================================================
// connectionStatus — the single source of truth for connection-state wording
// and severity. Both down-state surfaces consume it: the TopBar chip (label +
// detail as title) and the Launcher full panel (label + detail + retry).
// No other module phrases connection state.
// ============================================================================

import type { ConnectionState } from "./store.ts";

export interface ConnectionStatus {
	/** Short label — the chip text and the panel title. */
	label: string;
	/** Fuller explanation — the chip title and the panel sub-line. */
	detail: string;
	/** Severity — each surface maps it to its own CSS classes. */
	tone: "muted" | "warn" | "err";
}

/** Null when connected (no affordance rendered). */
export function connectionStatus(state: ConnectionState): ConnectionStatus | null {
	switch (state.kind) {
		case "connected":
			return null;
		case "connecting":
			return { label: "Connecting…", detail: "Connecting to the daemon", tone: "muted" };
		case "reconnecting":
			return {
				label: "Reconnecting…",
				detail: `Connection dropped — retrying (attempt ${state.attempt})`,
				tone: "warn",
			};
		case "unreachable":
			return {
				label: "Can't reach pi-bridge",
				detail: "pi-bridge isn't running, or the connection was dropped — retrying",
				tone: "err",
			};
		case "init_failed":
			return {
				label: "Daemon unresponsive",
				detail: state.error || "Connected, but the server didn't respond",
				tone: "err",
			};
	}
}
