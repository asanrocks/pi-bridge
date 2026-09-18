// ============================================================================
// Singleton BridgeClient — the connection-layer writer is useConnection
// (sets on open, clears on close); useRpc and the pull loop read it.
// Extracted so the three modules don't import each other.
// ============================================================================

import type { BridgeClient } from "../../../../src/core/index.ts";

let globalClient: BridgeClient | null = null;

export function getGlobalClient(): BridgeClient | null {
	return globalClient;
}

export function setGlobalClient(client: BridgeClient | null): void {
	globalClient = client;
}
