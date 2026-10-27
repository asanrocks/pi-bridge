/**
 * Layer 1: a faithful TypeScript mirror of the endpoint.
 *
 * This entry point is runtime-neutral. Audio sources are the caller's business:
 * feed {@link AsrSession.push} with 16 kHz mono PCM and everything else is
 * handled here. Platform entry points (`./browser`, `./node`) only differ in
 * transport capabilities and in the credential helpers they can offer.
 */

export { Resampler } from "./audio/resample.ts";
export type { ResolvedAuth } from "./auth.ts";
export { resolveAuth, withQuery } from "./auth.ts";
export {
	ASR_AID,
	ASR_APP_KEY,
	ASR_URL,
	DEVICE_REGISTER_URL,
	IME_USER_AGENT,
	KEEPALIVE_HEADER,
	PROTO_VERSION_HEADER,
	PROTO_VERSION_VALUE,
	SAMPLE_RATE,
	TOKEN_URL,
} from "./constants.ts";
export type { AsrErrorCode, AsrErrorInit } from "./errors.ts";
export {
	AsrError,
	codeForStatus,
	isAuthExpired,
	retryableForStatus,
	ServerStatus,
} from "./errors.ts";
export type { AudioFramerOptions } from "./framer.ts";
export { AudioFramer } from "./framer.ts";
export type { ClientEvent, JsonEnvelope, ParsedEnvelope } from "./protocol/json.ts";
export { encodeEnvelope, parseEnvelope } from "./protocol/json.ts";
export type { AsrRequest, AsrResponse } from "./protocol/protobuf.ts";
export { decodeAsrResponse, encodeAsrRequest, FrameState } from "./protocol/protobuf.ts";
export type { ParsedResults } from "./protocol/results.ts";
export { parseResults } from "./protocol/results.ts";
export type { AsrSessionOptions, FinishOutcome, SessionPhase, SessionStats } from "./session.ts";
export { AsrSession } from "./session.ts";
export type { Transport, TransportCapabilities, TransportMessage } from "./transport.ts";
export { webSocketTransport } from "./transport.ts";
export type {
	AsrEvent,
	AudioCodec,
	Auth,
	DeviceCredentials,
	FrameMs,
	JsonObject,
	JsonPrimitive,
	JsonValue,
	ServerMessage,
	TrackResult,
	Wire,
} from "./types.ts";
