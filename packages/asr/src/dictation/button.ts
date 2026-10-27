/// <reference lib="dom" />

/**
 * The affordance: a button that shows the dictation's phase and level.
 *
 * Deliberately blind. It knows one element, one {@link Dictation}, and two
 * channels: `subscribe` for the discrete phase and `onLevel` for the ~50 Hz
 * meter. It never touches the session, the microphone, the host document, or
 * the text, and it writes no stylesheet — only `data-state`, `data-sending`,
 * `data-speaking` and one CSS custom property — so the page keeps ownership of
 * layout, focus ring and palette. That is what lets a token-governed React
 * composer and a bare DOM demo share this code.
 *
 * Two behavioural rules are not negotiable:
 *
 * - `pointerdown` is prevented, so pressing the button never moves focus. A
 *   compose field treats blur as "the user left" and will collapse, save or
 *   restore the draft underneath the dictation.
 * - In `hold` mode the release is heard on `window`, because a pointer that
 *   leaves the button while the user is still speaking must not stop capture.
 * - `auto` mode is resolved per interaction from the pointer itself, so a
 *   touchscreen laptop holds under a finger and latches under a mouse instead of
 *   guessing at bind time from `matchMedia`.
 */
import type { Dictation, DictationMode, DictationPhase } from "./control.ts";
import type { LevelReading } from "./level.ts";

export interface DictationButtonOptions {
	/** CSS custom property that receives 0..1, default `--asr-level`. */
	levelProperty?: string;
	/** Accessible labels per phase; the button is icon-only, so this is the name. */
	labels?: Partial<Record<DictationPhase["kind"], string>>;
}

const DEFAULT_LABELS: Record<DictationPhase["kind"], string> = {
	idle: "Start dictation",
	preparing: "Preparing the microphone",
	listening: "Stop dictation",
	committing: "Finishing dictation",
	failed: "Dictation failed, try again",
};

/** Bind the affordance to an element the caller owns and renders. */
export function bindButton(
	element: HTMLElement,
	dictation: Dictation,
	options: DictationButtonOptions = {},
): () => void {
	const property = options.levelProperty ?? "--asr-level";
	const labels = { ...DEFAULT_LABELS, ...options.labels };

	/** True between press and release in `hold` mode. */
	let holding = false;

	const release = (): void => {
		if (!holding) return;
		holding = false;
		window.removeEventListener("pointerup", release);
		window.removeEventListener("pointercancel", release);
		window.removeEventListener("keyup", release);
		void dictation.stop();
	};

	const begin = (): void => {
		if (holding) return;
		holding = true;
		window.addEventListener("pointerup", release);
		window.addEventListener("pointercancel", release);
		void dictation.start();
	};

	const beginFromKey = (): void => {
		if (holding) return;
		holding = true;
		window.addEventListener("keyup", release);
		void dictation.start();
	};

	// Losing the window (cmd-tab, a modal, devtools) never delivers `pointerup`,
	// so a hold would otherwise capture until the next press.
	const onBlur = (): void => {
		release();
	};

	const onPointerDown = (event: PointerEvent): void => {
		if (event.button !== 0) return;
		// Before any branch: focus must stay in the field for both modes.
		event.preventDefault();
		if (resolveMode(dictation.mode, event.pointerType) === "hold") {
			begin();
			return;
		}
		if (dictation.isActive) void dictation.stop();
		else void dictation.start();
	};

	const onKeyDown = (event: KeyboardEvent): void => {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		if (event.repeat) return;
		// A held key has no release-to-commit affordance on a desktop keyboard, so
		// `auto` is always the latching form here.
		if (resolveMode(dictation.mode, "keyboard") === "hold") {
			beginFromKey();
			return;
		}
		if (dictation.isActive) void dictation.stop();
		else void dictation.start();
	};

	const render = (phase: DictationPhase): void => {
		element.dataset.state = phase.kind;
		// Audio before the handshake is real capture, so `listening` is already
		// shown; this is the one hint that the server has not been reached yet.
		if (phase.kind === "listening") element.dataset.sending = phase.sending ? "true" : "false";
		else delete element.dataset.sending;
		element.setAttribute("aria-pressed", phase.kind === "listening" ? "true" : "false");
		element.setAttribute("aria-label", labels[phase.kind]);
		element.title = labels[phase.kind];
	};

	const renderLevel = (reading: LevelReading): void => {
		element.style.setProperty(property, reading.level.toFixed(3));
		element.dataset.speaking = reading.speaking ? "true" : "false";
	};

	element.addEventListener("pointerdown", onPointerDown);
	element.addEventListener("keydown", onKeyDown);
	window.addEventListener("blur", onBlur);
	const stopPhase = dictation.subscribe(render);
	const stopLevel = dictation.onLevel(renderLevel);
	render(dictation.phase);

	return () => {
		// Teardown must not finish the utterance: the controller outlives the
		// element (a React composer remounts while a dictation is still running),
		// and `dispose()`/`cancel()` own the ending.
		holding = false;
		window.removeEventListener("pointerup", release);
		window.removeEventListener("pointercancel", release);
		window.removeEventListener("keyup", release);
		element.removeEventListener("pointerdown", onPointerDown);
		element.removeEventListener("keydown", onKeyDown);
		window.removeEventListener("blur", onBlur);
		stopPhase();
		stopLevel();
		delete element.dataset.state;
		delete element.dataset.sending;
		delete element.dataset.speaking;
		element.style.removeProperty(property);
		element.removeAttribute("aria-pressed");
	};
}

/**
 * `auto` matches the thing that is pressing: a finger or a pen is a press-and-talk
 * gesture, a mouse or a key is a latch. An unknown `pointerType` (old browsers,
 * a page that never reports one) falls back to the desktop form, which is also
 * what the keyboard gets.
 */
function resolveMode(configured: DictationMode, pointerType: unknown): "hold" | "toggle" {
	if (configured !== "auto") return configured;
	return pointerType === "touch" || pointerType === "pen" ? "hold" : "toggle";
}
