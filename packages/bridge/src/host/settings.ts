// ============================================================================
// Bridge settings — a small, bridge-owned preferences file beside pi's
// settings.json (ADR 15). pi preserves unknown keys in its own file but
// exposes no setter for a bridge-only key, so bridge owns its file rather
// than writing an unofficial key into pi's.
//
// Location: <agentDir>/bridge/settings.json
// ============================================================================

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const BRIDGE_SETTINGS_DIR = "bridge";
export const BRIDGE_SETTINGS_FILE = "settings.json";

export interface BridgeSettings {
	/** Canonical `provider/modelId` minimatch patterns selecting the picker's
	 * "normal" tier (model-visibility.ts). Absent or empty = every catalogue
	 * model is normal, so nothing folds. */
	visibleModels?: string[];
}

export function bridgeSettingsPath(agentDir: string): string {
	return join(agentDir, BRIDGE_SETTINGS_DIR, BRIDGE_SETTINGS_FILE);
}

/** Read the bridge settings file. A missing or malformed file yields `{}`:
 * bridge preferences are decoration and must never fail daemon startup.
 * Unknown keys are ignored; a non-string `visibleModels` entry is dropped. */
export function readBridgeSettings(agentDir: string): BridgeSettings {
	const path = bridgeSettingsPath(agentDir);
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		const record = parsed as Record<string, unknown>;
		const out: BridgeSettings = {};
		if (Array.isArray(record.visibleModels)) {
			out.visibleModels = record.visibleModels.filter((pattern): pattern is string => typeof pattern === "string");
		}
		return out;
	} catch {
		// Malformed JSON or an unreadable file: treat as "no preferences".
		return {};
	}
}
