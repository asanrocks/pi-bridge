/**
 * `AsrRequest` / `AsrResponse` codec for the protobuf wire format.
 *
 * Hand-written on purpose: the schema is six fields wide and fixed, so a
 * dependency would cost more than it saves. Both directions keep the original
 * bytes (`raw`) so callers can still inspect fields the server adds later.
 */
import { AsrError } from "../errors.ts";

/**
 * `frame_state` of an audio packet. The server rejects a `last` that is not
 * preceded by a `first`, which is why {@link AudioFramer} always opens with one.
 */
export const FrameState = { first: 1, middle: 3, last: 9 } as const;
export type FrameState = (typeof FrameState)[keyof typeof FrameState];

const RequestField = {
	token: 2,
	serviceName: 3,
	methodName: 5,
	payload: 6,
	audio: 7,
	requestId: 8,
	frameState: 9,
} as const;

const ResponseField = {
	messageType: 4,
	statusCode: 5,
	statusMessage: 6,
	resultJson: 7,
} as const;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function writeVarint(out: number[], value: number): void {
	let rest = value;
	while (rest > 0x7f) {
		out.push((rest & 0x7f) | 0x80);
		rest = Math.floor(rest / 128);
	}
	out.push(rest);
}

function writeLengthDelimited(out: number[], field: number, bytes: Uint8Array): void {
	// Protobuf omits empty values; a zero-length field is legal but the server has
	// only ever been observed with omitted ones.
	if (bytes.length === 0) return;
	writeVarint(out, (field << 3) | 2);
	writeVarint(out, bytes.length);
	for (const byte of bytes) out.push(byte);
}

function writeString(out: number[], field: number, value: string): void {
	if (value.length === 0) return;
	writeLengthDelimited(out, field, textEncoder.encode(value));
}

function writeVarintField(out: number[], field: number, value: number): void {
	if (value === 0) return;
	writeVarint(out, field << 3);
	writeVarint(out, value);
}

export interface AsrRequest {
	/** App key on the session methods; empty for audio packets (as the IME sends it). */
	token?: string;
	serviceName?: string;
	/** `StartTask` | `StartSession` | `TaskRequest` | `FinishSession`. */
	methodName: string;
	/** Session config JSON for `StartSession`, audio metadata JSON for `TaskRequest`. */
	payload?: string;
	/** One encoded audio frame. */
	audio?: Uint8Array;
	requestId: string;
	frameState?: FrameState;
}

export function encodeAsrRequest(request: AsrRequest): Uint8Array {
	const out: number[] = [];
	if (request.token !== undefined) writeString(out, RequestField.token, request.token);
	writeString(out, RequestField.serviceName, request.serviceName ?? "ASR");
	writeString(out, RequestField.methodName, request.methodName);
	if (request.payload !== undefined) writeString(out, RequestField.payload, request.payload);
	if (request.audio !== undefined) writeLengthDelimited(out, RequestField.audio, request.audio);
	writeString(out, RequestField.requestId, request.requestId);
	if (request.frameState !== undefined) {
		writeVarintField(out, RequestField.frameState, request.frameState);
	}
	return Uint8Array.from(out);
}

export interface AsrResponse {
	messageType: string;
	statusCode: number;
	statusMessage: string;
	resultJson: string;
	raw: Uint8Array;
}

/** Sequential reader; every access is bounds-checked because frames come off the network. */
class Reader {
	private offset = 0;
	private readonly bytes: Uint8Array;

	constructor(bytes: Uint8Array) {
		this.bytes = bytes;
	}

	get done(): boolean {
		return this.offset >= this.bytes.length;
	}

	varint(): number {
		let result = 0;
		let shift = 0;
		for (;;) {
			const byte = this.take(1)[0];
			if (byte === undefined) throw new AsrError("protocol", "protobuf: truncated frame");
			result += (byte & 0x7f) * 2 ** shift;
			if ((byte & 0x80) === 0) return result;
			shift += 7;
			// Protobuf caps varints at 10 bytes; anything longer is a desync, not a number.
			if (shift > 49) throw new AsrError("protocol", "protobuf: varint too long");
		}
	}

	take(length: number): Uint8Array {
		const end = this.offset + length;
		if (end > this.bytes.length) throw new AsrError("protocol", "protobuf: truncated field");
		const view = this.bytes.subarray(this.offset, end);
		this.offset = end;
		return view;
	}
}

export function decodeAsrResponse(bytes: Uint8Array): AsrResponse {
	const reader = new Reader(bytes);
	let messageType = "";
	let statusCode = 0;
	let statusMessage = "";
	let resultJson = "";

	while (!reader.done) {
		const tag = reader.varint();
		const field = tag >>> 3;
		const wireType = tag & 0x7;

		switch (wireType) {
			case 0: {
				const value = reader.varint();
				if (field === ResponseField.statusCode) statusCode = value;
				break;
			}
			case 1:
				reader.take(8);
				break;
			case 2: {
				const value = textDecoder.decode(reader.take(reader.varint()));
				switch (field) {
					case ResponseField.messageType:
						messageType = value;
						break;
					case ResponseField.statusMessage:
						statusMessage = value;
						break;
					case ResponseField.resultJson:
						resultJson = value;
						break;
					default:
						// request_id, task_id, service_name, and anything added later.
						break;
				}
				break;
			}
			case 5:
				reader.take(4);
				break;
			default:
				throw new AsrError("protocol", `protobuf: unsupported wire type ${String(wireType)}`);
		}
	}

	return { messageType, statusCode, statusMessage, resultJson, raw: bytes };
}
