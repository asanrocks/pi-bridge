/**
 * The orchestrator: dictation as a thing a page can put a button on.
 *
 * It sequences the three layers and both providers without adding protocol or
 * editing semantics of its own — the microphone feeds `push()`, the session
 * reports, the editing model owns a span — and it is the only place allowed to
 * know all of them at once. Ordering is not knowledge, so this is not a fourth
 * layer; keeping it one module is what stops it becoming a component library.
 *
 * `bindButton` is the DOM half, and it only binds: the library creates no
 * elements and applies no styles. Nothing here forces a consumer to use it.
 */

export type { DictationButtonOptions } from "./button.ts";
export { bindButton } from "./button.ts";
export type {
	DictationMode,
	DictationOptions,
	DictationPhase,
	DictationResult,
	DictationSettlementListener,
} from "./control.ts";
export { Dictation, isFatalError } from "./control.ts";
export type { LevelOptions, LevelReading } from "./level.ts";
export { LevelMeter } from "./level.ts";
