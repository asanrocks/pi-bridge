/**
 * `result_json` / `payload` decoder shared by both wire formats.
 *
 * It only unwraps the document: track selection, interim/final policy and text
 * merging belong to the caller. Keeping that split is what makes the server's
 * revisions — text that shrinks, moves, or gets re-punctuated across segments —
 * somebody else's problem.
 */
import { isJsonObject, parseJsonObject, readArray, readBoolean, readNumber, readObject, readString } from "../json.ts";
import type { JsonObject, TrackResult } from "../types.ts";

export interface ParsedResults {
	/** Empty when the payload carried no `results` array at all (heartbeat). */
	tracks: TrackResult[];
	/** True when `results` was absent or null, i.e. this is the keepalive message. */
	heartbeat: boolean;
	/** Message-level `extra`; carries `vad_start`, `client_ip`, heartbeat counters. */
	extra: JsonObject | null;
	/** `extra.vad_start`: the server detected speech and no text is expected yet. */
	vadStart: boolean;
}

export function parseResults(payloadText: string): ParsedResults | null {
	const document = parseJsonObject(payloadText);
	if (document === null) return null;

	const rawResults = readArray(document, "results");
	const tracks: TrackResult[] = [];
	if (rawResults !== undefined) {
		for (const [index, entry] of rawResults.entries()) {
			if (!isJsonObject(entry)) continue;
			const text = readString(entry, "text");
			if (text === undefined) continue;

			const extra = readObject(entry, "extra");
			const track: TrackResult = {
				track: index,
				text,
				interim: readBoolean(entry, "is_interim") ?? true,
				vadFinished: readBoolean(entry, "is_vad_finished") ?? false,
				nonstream: extra !== undefined && readBoolean(extra, "nonstream_result") === true,
				raw: entry,
			};
			const startTime = readNumber(entry, "start_time");
			if (startTime !== undefined) track.startTime = startTime;
			const endTime = readNumber(entry, "end_time");
			if (endTime !== undefined) track.endTime = endTime;
			if (extra !== undefined) track.extra = extra;
			tracks.push(track);
		}
	}

	const extra = readObject(document, "extra") ?? null;
	return {
		tracks,
		heartbeat: !Array.isArray(rawResults),
		extra,
		vadStart: extra !== null && readBoolean(extra, "vad_start") === true,
	};
}
