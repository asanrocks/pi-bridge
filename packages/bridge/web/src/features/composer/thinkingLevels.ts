// ============================================================================
// Pre-session thinking-level display — mirrors `clampThinkingLevel` in
// @earendil-works/pi-ai, so the level the Project home shows for a model is
// the level the session runs at: the host clamps the same way at session
// creation and when `newSession` applies a model pick. The browser imports
// nothing from pi-ai, so the level order lives here beside the picker.
// ============================================================================

/** pi's thinking levels, weakest to strongest. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** The requested level clamped to a model's supported levels: the level itself
 * when supported, else the nearest stronger level, else the nearest weaker
 * one. `supported` is `ModelInfo.supportedThinkingLevels`; when it is absent
 * (older daemon, unknown model) the level is returned unchanged. */
export function clampToSupportedLevels(level: string, supported: readonly string[] | undefined): string {
	if (!supported || supported.includes(level)) return level;
	const ordered: readonly string[] = THINKING_LEVELS;
	const requestedIndex = ordered.indexOf(level);
	if (requestedIndex === -1) return supported[0] ?? level;
	for (let i = requestedIndex; i < ordered.length; i++) {
		if (supported.includes(ordered[i])) return ordered[i];
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		if (supported.includes(ordered[i])) return ordered[i];
	}
	return supported[0] ?? level;
}
