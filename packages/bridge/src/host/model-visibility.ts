// ============================================================================
// Model visibility — resolves bridge settings' `visibleModels` patterns into
// the picker's "normal" tier.
//
// A pattern is matched, with minimatch and case-insensitively, against the full
// canonical `provider/modelId` reference. `/` is a path separator, so `*` stays
// within a segment and `**` crosses them: `deepseek/*` selects the models
// DeepSeek serves and never an OpenRouter-routed `openrouter/deepseek/...`
// model, while `**/claude-*-5*` reaches a routed
// `openrouter/anthropic/claude-…`. A pattern without a `/` (e.g. a bare id) is
// not a canonical reference and matches nothing. An optional trailing
// `:thinkingLevel` is stripped, so a pattern copied from `enabledModels` keeps
// its model meaning.
//
// Resolution is host-side on purpose: the browser needs no glob engine, and
// the wire carries the resulting `provider/modelId` keys.
// ============================================================================

import { minimatch } from "minimatch";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function stripThinkingLevel(pattern: string): string {
	const colon = pattern.lastIndexOf(":");
	if (colon === -1) return pattern;
	return THINKING_LEVELS.has(pattern.slice(colon + 1)) ? pattern.slice(0, colon) : pattern;
}

/** True when `model` matches any `visibleModels` pattern. A malformed pattern
 * matches nothing, so a typo degrades to "everything folds" — recoverable,
 * because folded models stay reachable through the picker's disclosure. */
export function isModelVisible(model: { provider: string; id: string }, patterns: readonly string[]): boolean {
	const ref = `${model.provider}/${model.id}`;
	for (const raw of patterns) {
		const pattern = stripThinkingLevel(raw);
		if (pattern === "") continue;
		try {
			if (minimatch(ref, pattern, { nocase: true, nonegate: true })) return true;
		} catch {
			// Ignore malformed patterns.
		}
	}
	return false;
}

/** The `provider/modelId` keys of every catalogue model matching a pattern. */
export function resolveVisibleModelKeys(
	patterns: readonly string[],
	models: readonly { provider: string; id: string }[],
): string[] {
	const keys: string[] = [];
	for (const model of models) {
		if (isModelVisible(model, patterns)) keys.push(`${model.provider}/${model.id}`);
	}
	return keys;
}
