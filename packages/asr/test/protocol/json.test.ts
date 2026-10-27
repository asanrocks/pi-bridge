import { describe, expect, it } from "vitest";
import { AsrError } from "../../src/errors.ts";
import { encodeEnvelope, parseEnvelope } from "../../src/protocol/json.ts";

describe("JSON envelope", () => {
	it("round-trips the fields the client sends", () => {
		const raw = encodeEnvelope({
			task_id: "t",
			session_id: "s",
			namespace: "ASR",
			event: "StartTask",
			appkey: "OrnqKvSSrs",
			token: "token",
			payload: '{"audio_format":"raw_pcm"}',
		});
		const parsed = parseEnvelope(raw);
		expect(parsed.event).toBe("StartTask");
		expect(parsed.statusCode).toBe(0);
		expect(parsed.payload).toBe('{"audio_format":"raw_pcm"}');
		expect(parsed.data).toEqual({ audio_format: "raw_pcm" });
	});

	it("reads server status and keeps a payload that is not an object", () => {
		const parsed = parseEnvelope(
			JSON.stringify({
				event: "TaskFailed",
				status_code: 40_200_001,
				status_text: "IllegalToken",
				payload: '"x"',
			}),
		);
		expect(parsed.statusCode).toBe(40_200_001);
		expect(parsed.statusText).toBe("IllegalToken");
		expect(parsed.payload).toBe('"x"');
		expect(parsed.data).toBeNull();
	});

	it("tolerates missing optional fields", () => {
		const parsed = parseEnvelope('{"event":"TaskFinished"}');
		expect(parsed.event).toBe("TaskFinished");
		expect(parsed.payload).toBe("");
		expect(parsed.data).toBeNull();
	});

	it("passes unknown fields through instead of dropping them", () => {
		// §10.2: L1 must not interpret fields it does not know, because the private
		// endpoint adds them without notice. `raw` is the escape hatch.
		const raw = JSON.stringify({
			event: "TaskFinished",
			message_id: "m-1",
			status_code: 20_000_000,
			payload: '{"results":null,"future_field":{"nested":true}}',
		});
		const parsed = parseEnvelope(raw);
		expect(parsed.raw).toBe(raw);
		expect(parsed.event).toBe("TaskFinished");
		expect(parsed.payload).toContain("future_field");
	});

	it("reports malformed envelopes as protocol errors", () => {
		expect(() => parseEnvelope("not json")).toThrow(AsrError);
		expect(() => parseEnvelope("[]")).toThrow(/not an object/);
	});
});
