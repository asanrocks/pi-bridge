/**
 * Layer 1, Node entry point.
 *
 * Adds the two things only a server-side runtime can do: set the
 * `proto-version` header (which unlocks the protobuf wire) and talk to the two
 * credential endpoints, neither of which sends CORS headers.
 */

export type { RegisterDeviceOptions } from "./device.ts";
export { registerDevice } from "./device.ts";
export * from "./index.ts";
export type { MintedToken, MintTokenOptions } from "./token.ts";
export { DEFAULT_TOKEN_TTL_MS, mintSamiToken } from "./token.ts";

import type { Transport } from "./transport.ts";
import { webSocketTransport } from "./transport.ts";

/** Node's `WebSocket` accepts `{ headers }`, so this transport can carry protobuf. */
export function nodeTransport(): Transport {
	return webSocketTransport({ headers: true });
}
