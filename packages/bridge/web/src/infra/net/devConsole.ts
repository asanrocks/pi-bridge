// ============================================================================
// devConsole — dev-mode console relay (--dev): hook console.* so browser
// calls are forwarded to the server as `console` RPC frames.
//
// The hooks are installed exactly once per page: re-hooking on reconnect
// repoints the relay at the new client instead of nesting another wrapper
// (nested wrappers would relay each line once per connection the page ever
// had, through clients whose sockets are already dead). Unhook on connection
// close or teardown restores the original methods.
// ============================================================================

import type { BridgeClient, JsonValue } from "../../../../src/core/index.ts";

const LEVELS = ["log", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

let activeClient: BridgeClient | null = null;
let originals: Record<Level, (...args: unknown[]) => void> | null = null;

/**
 * Point the relay at `client` and install the console hooks (once). Safe to
 * call for every connection whose daemon reports dev mode.
 */
export function hookConsole(client: BridgeClient): void {
	activeClient = client;
	if (originals !== null) return;
	originals = { log: console.log, warn: console.warn, error: console.error };
	for (const level of LEVELS) {
		console[level] = (...args: unknown[]) => {
			originals![level](...args);
			activeClient?.console(
				level,
				args.map((a) => safeJsonValue(a)),
			);
		};
	}
}

/**
 * Restore the original console methods and drop the relay target. No-op when
 * the hooks are not installed.
 */
export function unhookConsole(): void {
	if (originals === null) return;
	for (const level of LEVELS) console[level] = originals[level];
	originals = null;
	activeClient = null;
}

function safeJsonValue(v: unknown): JsonValue {
	if (v === null || v === undefined) return null;
	if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
	if (v instanceof Error) return v.message;
	try {
		return JSON.parse(JSON.stringify(v)) as JsonValue;
	} catch {
		return String(v);
	}
}
