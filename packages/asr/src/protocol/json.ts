/**
 * Envelope codec for the JSON wire format.
 *
 * Same endpoint as the protobuf wire, selected by the absence of the
 * `proto-version` header — and therefore the only wire a page can use, since
 * browsers cannot set request headers. Audio does not travel in here: it goes
 * out as bare binary WebSocket frames. Putting it in `payload` is accepted by
 * the server and then silently ignored (that is the tuff implementation's bug).
 */
import { AsrError } from "../errors.ts";
import { isJsonObject, parseJsonObject, readNumber, readString } from "../json.ts";
import type { JsonObject } from "../types.ts";

/** Events the client sends. Responses use their own names, so the type stays open. */
export type ClientEvent = "StartTask" | "FinishTask" | "CancelTask";

/** The envelope both directions use. `payload` is itself JSON text. */
export interface JsonEnvelope {
	task_id: string;
	session_id: string;
	namespace: "ASR";
	event: string;
	appkey?: string;
	token?: string;
	payload?: string;
	/** JSON text; only the official clients' `TaskRequest` uses it. */
	extra?: string;
}

export function encodeEnvelope(envelope: JsonEnvelope): string {
	return JSON.stringify(envelope);
}

export interface ParsedEnvelope {
	event: string;
	statusCode: number;
	statusText: string;
	/** Payload text as received; empty when the message carries none. */
	payload: string;
	/** `payload` decoded as an object, or null when absent or not an object. */
	data: JsonObject | null;
	raw: string;
}

export function parseEnvelope(raw: string): ParsedEnvelope {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new AsrError("protocol", "json: malformed envelope", { cause: error });
	}
	if (!isJsonObject(parsed)) {
		throw new AsrError("protocol", "json: envelope is not an object");
	}

	const payload = readString(parsed, "payload") ?? "";
	return {
		event: readString(parsed, "event") ?? "",
		statusCode: readNumber(parsed, "status_code") ?? 0,
		statusText: readString(parsed, "status_text") ?? "",
		payload,
		data: parseJsonObject(payload),
		raw,
	};
}
