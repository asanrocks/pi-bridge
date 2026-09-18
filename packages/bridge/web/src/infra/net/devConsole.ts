// ============================================================================
// devConsole — dev-mode console relay (--dev): hook console.* so browser
// calls are forwarded to the server as `console` RPC frames. Re-hooked per
// connection when the daemon reports devMode; the hooks wrap whatever
// console holds at hook time.
// ============================================================================

import type { BridgeClient, JsonValue } from "../../../../src/core/index.ts";

export function hookConsole(client: BridgeClient): void {
	const levels = ["log", "warn", "error"] as const;
	for (const level of levels) {
		const original = console[level];
		console[level] = (...args: unknown[]) => {
			original(...args);
			client.console(
				level,
				args.map((a) => safeJsonValue(a)),
			);
		};
	}
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
