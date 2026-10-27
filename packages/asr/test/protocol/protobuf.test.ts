import { describe, expect, it } from "vitest";
import { decodeAsrResponse, encodeAsrRequest, FrameState } from "../../src/protocol/protobuf.ts";
import { decodeRequest } from "../../src/testing/mock-transport.ts";

describe("encodeAsrRequest", () => {
	it("emits the field numbers the server expects, in order", () => {
		const bytes = encodeAsrRequest({
			token: "k",
			serviceName: "ASR",
			methodName: "StartTask",
			requestId: "r",
		});
		// 2:"k"  3:"ASR"  5:"StartTask"  8:"r"
		expect(Array.from(bytes)).toEqual([
			0x12, 0x01, 0x6b, 0x1a, 0x03, 0x41, 0x53, 0x52, 0x2a, 0x09, 0x53, 0x74, 0x61, 0x72, 0x74, 0x54, 0x61, 0x73,
			0x6b, 0x42, 0x01, 0x72,
		]);
	});

	it("defaults service_name to ASR and omits empty values", () => {
		const decoded = decodeRequest(encodeAsrRequest({ token: "", methodName: "FinishSession", requestId: "id" }));
		expect(decoded.serviceName).toBe("ASR");
		expect(decoded.token).toBeUndefined();
		expect(decoded.audio).toBeUndefined();
		expect(decoded.payload).toBeUndefined();
		expect(decoded.frameState).toBeUndefined();
	});

	it("carries audio and frame state on TaskRequest", () => {
		const audio = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
		const decoded = decodeRequest(
			encodeAsrRequest({
				methodName: "TaskRequest",
				requestId: "id",
				audio,
				frameState: FrameState.last,
				payload: '{"timestamp_ms":1}',
			}),
		);
		expect(decoded.methodName).toBe("TaskRequest");
		expect(Array.from(decoded.audio ?? [])).toEqual([0xde, 0xad, 0xbe, 0xef]);
		expect(decoded.frameState).toBe(9);
		expect(decoded.payload).toBe('{"timestamp_ms":1}');
	});

	it("encodes all three frame states as varints", () => {
		for (const [name, state] of Object.entries(FrameState)) {
			const decoded = decodeRequest(
				encodeAsrRequest({ methodName: "TaskRequest", requestId: "id", frameState: state }),
			);
			expect(decoded.frameState, name).toBe(state);
		}
	});
});

describe("decodeAsrResponse", () => {
	it("reads message type, status, message and result JSON", () => {
		const bytes = encodeResponse({
			type: "TaskStarted",
			status: 20_000_000,
			message: "OK",
			resultJson: '{"results":null}',
		});
		const response = decodeAsrResponse(bytes);
		expect(response.messageType).toBe("TaskStarted");
		expect(response.statusCode).toBe(20_000_000);
		expect(response.statusMessage).toBe("OK");
		expect(response.resultJson).toBe('{"results":null}');
	});

	it("skips unknown fields and unknown-but-supported wire types", () => {
		const bytes = Uint8Array.from([
			// field 1 (request_id), length-delimited
			(1 << 3) | 2,
			0x02,
			0x61,
			0x62,
			// field 4 message_type = "X"
			(4 << 3) | 2,
			0x01,
			0x58,
			// field 40, varint — a field the server may add later
			...varint((40 << 3) | 0),
			0x2a,
			// field 41, fixed32
			(41 << 3) | 5,
			0x01,
			0x02,
			0x03,
			0x04,
			// field 42, fixed64
			(42 << 3) | 1,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			// field 5 status_code = 20000000
			...varint(5 << 3),
			...varint(20_000_000),
		]);
		const response = decodeAsrResponse(bytes);
		expect(response.messageType).toBe("X");
		expect(response.statusCode).toBe(20_000_000);
	});

	it("rejects an unsupported wire type instead of desyncing silently", () => {
		const bytes = Uint8Array.from([(7 << 3) | 3]);
		expect(() => decodeAsrResponse(bytes)).toThrow(/unsupported wire type/);
	});

	it("rejects truncated frames", () => {
		expect(() => decodeAsrResponse(Uint8Array.from([(4 << 3) | 2, 0x05, 0x61]))).toThrow(/truncated/);
	});

	it("rejects a varint that never terminates", () => {
		const bytes = new Uint8Array(12).fill(0x80);
		expect(() => decodeAsrResponse(bytes)).toThrow(/varint too long/);
	});
});

function varint(value: number): number[] {
	const out: number[] = [];
	let rest = value;
	while (rest > 0x7f) {
		out.push((rest & 0x7f) | 0x80);
		rest = Math.floor(rest / 128);
	}
	out.push(rest);
	return out;
}

function encodeResponse(input: { type: string; status: number; message: string; resultJson: string }): Uint8Array {
	const out: number[] = [];
	const encoder = new TextEncoder();
	const field = (number: number, value: string): void => {
		if (value.length === 0) return;
		const bytes = encoder.encode(value);
		out.push((number << 3) | 2, ...varint(bytes.length), ...bytes);
	};
	field(4, input.type);
	out.push(5 << 3, ...varint(input.status));
	field(6, input.message);
	field(7, input.resultJson);
	return Uint8Array.from(out);
}
