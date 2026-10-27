import type { JsonObject } from "./types.ts";

/** Narrowing helpers for `JSON.parse` output, which is `any` and stays unknown here. */
export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(object: JsonObject, key: string): string | undefined {
	const value = object[key];
	return typeof value === "string" ? value : undefined;
}

export function readBoolean(object: JsonObject, key: string): boolean | undefined {
	const value = object[key];
	return typeof value === "boolean" ? value : undefined;
}

export function readNumber(object: JsonObject, key: string): number | undefined {
	const value = object[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readObject(object: JsonObject, key: string): JsonObject | undefined {
	const value = object[key];
	return isJsonObject(value) ? value : undefined;
}

export function readArray(object: JsonObject, key: string): unknown[] | undefined {
	const value = object[key];
	return Array.isArray(value) ? value : undefined;
}

/** Parse a JSON object, returning null for anything else (including malformed input). */
export function parseJsonObject(text: string): JsonObject | null {
	if (text.length === 0) return null;
	try {
		const parsed: unknown = JSON.parse(text);
		return isJsonObject(parsed) ? parsed : null;
	} catch {
		return null;
	}
}
