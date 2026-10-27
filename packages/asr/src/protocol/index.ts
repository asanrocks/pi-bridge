/**
 * Protocol codecs, usable without any transport.
 *
 * Exported as `@earendil-works/pi-asr/protocol` for callers that speak to the endpoint
 * through their own channel: a browser extension with header rewriting, a
 * same-origin relay, or a test harness replaying captured frames.
 */

export type { ClientEvent, JsonEnvelope, ParsedEnvelope } from "./json.ts";
export { encodeEnvelope, parseEnvelope } from "./json.ts";
export type { AsrRequest, AsrResponse } from "./protobuf.ts";
export { decodeAsrResponse, encodeAsrRequest, FrameState } from "./protobuf.ts";
export type { ParsedResults } from "./results.ts";
export { parseResults } from "./results.ts";
