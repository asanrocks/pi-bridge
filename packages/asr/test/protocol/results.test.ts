import { describe, expect, it } from "vitest";
import { parseResults } from "../../src/protocol/results.ts";

describe("parseResults", () => {
	it("keeps every track in order and does not merge text", () => {
		const parsed = parseResults(
			JSON.stringify({
				results: [
					{ text: "你好，", is_interim: true, start_time: 0, end_time: 1.2 },
					{ text: "你好", is_interim: true, extra: { seq_id: 7 } },
				],
				extra: { client_ip: "127.0.0.1" },
			}),
		);
		expect(parsed?.tracks).toHaveLength(2);
		expect(parsed?.tracks[0]).toMatchObject({
			track: 0,
			text: "你好，",
			interim: true,
			vadFinished: false,
			nonstream: false,
			startTime: 0,
			endTime: 1.2,
		});
		expect(parsed?.tracks[1]).toMatchObject({ track: 1, text: "你好", nonstream: false });
		expect(parsed?.tracks[1]?.extra).toEqual({ seq_id: 7 });
		expect(parsed?.extra).toEqual({ client_ip: "127.0.0.1" });
	});

	it("flags the third-pass rewrite and the segment terminal flag", () => {
		const parsed = parseResults(
			JSON.stringify({
				results: [
					{ text: "终稿。", is_interim: false, is_vad_finished: true },
					{ text: "终稿", is_interim: false, extra: { nonstream_result: true } },
				],
			}),
		);
		// A non-terminal track can be `is_interim: false`; layer 1 must not hide it.
		expect(parsed?.tracks[0]).toMatchObject({ interim: false, vadFinished: true, nonstream: false });
		expect(parsed?.tracks[1]).toMatchObject({ track: 1, interim: false, nonstream: true });
	});

	it("keeps unknown result fields reachable", () => {
		// §10.2: unknown JSON fields are forwarded, not dropped or renamed, so a new
		// server field can be read without a codec change.
		const parsed = parseResults(
			JSON.stringify({
				results: [{ text: "你好", is_interim: true, future_flag: 1, extra: { new_key: "x" } }],
				future_top: { a: 1 },
			}),
		);
		const track = parsed?.tracks[0];
		expect(track?.raw).toMatchObject({ future_flag: 1 });
		expect(track?.extra).toEqual({ new_key: "x" });
	});

	it("recognises the keepalive payload", () => {
		const parsed = parseResults(JSON.stringify({ results: null, extra: { packet_number: 0, heartbeat_num: 3 } }));
		expect(parsed?.heartbeat).toBe(true);
		expect(parsed?.tracks).toEqual([]);
	});

	it("treats a missing results array as a keepalive but still reads extra", () => {
		const parsed = parseResults(JSON.stringify({ extra: { vad_start: true } }));
		expect(parsed?.heartbeat).toBe(true);
		expect(parsed?.vadStart).toBe(true);
	});

	it("reports vad_start on a results-bearing payload", () => {
		const parsed = parseResults(JSON.stringify({ results: [], extra: { vad_start: true } }));
		expect(parsed?.heartbeat).toBe(false);
		expect(parsed?.vadStart).toBe(true);
	});

	it("skips entries without text and returns null for malformed JSON", () => {
		const parsed = parseResults(JSON.stringify({ results: [{ nope: 1 }, { text: "x" }] }));
		expect(parsed?.tracks).toHaveLength(1);
		expect(parsed?.tracks[0]).toMatchObject({ track: 1, text: "x" });
		expect(parseResults("{oops")).toBeNull();
		expect(parseResults("")).toBeNull();
	});
});
