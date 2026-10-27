/**
 * Wire-level types shared by every layer.
 *
 * Layer 1 mirrors the server one-to-one: nothing here merges, deduplicates or
 * reinterprets results. Field names keep the server's snake_case so a value
 * read here can be matched against a captured frame verbatim.
 */

/** Values that can appear in the JSON documents carried by either wire format. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
// A `Record` alias cannot reference itself, so the recursive document type has
// to be an interface with an index signature.
export interface JsonObject {
	[key: string]: JsonValue;
}

/**
 * `protobuf` needs the `proto-version: v2` request header, so only Node and
 * same-origin proxies can use it; browsers fall back to the JSON envelope.
 */
export type Wire = "json" | "protobuf";

/**
 * `speech_opus` is ~10x smaller on the wire than `raw_pcm` (see
 * `docs/protocol.md` §5.3). Both are accepted by both wire formats.
 */
export type AudioCodec = "pcm" | "opus";

/** Frame durations the server has been observed to accept, per codec. */
export type FrameMs = 20 | 40 | 60 | 100;

/** Device credentials produced by {@link registerDevice} (Node only). */
export interface DeviceCredentials {
	deviceId: string;
	installId?: string;
}

/**
 * How a session authenticates.
 *
 * - `token`: a SAMI token minted server-side, or any string the caller wants to
 *   send. Only the JSON wire accepts it; the browser can only use this shape.
 * - `getToken`: same, resolved lazily so an expired token can be refreshed
 *   before the handshake.
 * - `device`: the fixed IME app key plus a registered `device_id` in the query
 *   string. The only shape the protobuf wire accepts. Requires no secret, but it
 *   is a shared identity, not a per-user one.
 */
export type Auth = { token: string } | { getToken: () => string | Promise<string> } | { device: DeviceCredentials };

/** One entry of `payload.results`, unwrapped but not interpreted. */
export interface TrackResult {
	/** Index in the server's `results` array. Track 0 is the session transcript. */
	track: number;
	text: string;
	interim: boolean;
	vadFinished: boolean;
	/** `extra.nonstream_result`: this segment was rewritten by the third pass. */
	nonstream: boolean;
	/** Segment bounds in seconds; only meaningful on per-segment tracks. */
	startTime?: number;
	endTime?: number;
	extra?: JsonObject;
	/** The object exactly as it appeared in the payload. */
	raw: JsonObject;
}

/** One decoded server message, before any interpretation. */
export interface ServerMessage {
	wire: Wire;
	/** `message_type` on the protobuf wire, `event` on the JSON wire. */
	type: string;
	status: number;
	statusMessage: string;
	/** `result_json` / `payload`; empty when the message carries no results. */
	payloadText: string;
	/** The frame as received, for logging or replay. */
	raw: string | Uint8Array;
}

export type AsrEvent =
	/** Handshake finished; audio sent after this point goes out immediately. */
	| { type: "open"; wire: Wire; codec: AudioCodec }
	/** Every server frame, verbatim and decoded, with nothing merged. */
	| { type: "message"; message: ServerMessage }
	/** The `results` array of one message, all tracks kept in order. */
	| { type: "results"; tracks: TrackResult[]; vadStart: boolean; extra: JsonObject | null }
	/**
	 * One track's text for this message. `final` marks the session-terminal
	 * message, decided by the wire format's own criterion (§6.3 of the protocol
	 * doc); it says nothing about how the caller should merge or display text.
	 */
	| {
			type: "text";
			track: number;
			text: string;
			interim: boolean;
			vadFinished: boolean;
			nonstream: boolean;
			final: boolean;
	  }
	/** A payload with no `results` array: the 200 ms keepalive. */
	| { type: "heartbeat" }
	| { type: "error"; error: Error }
	| { type: "closed"; reason?: string };
