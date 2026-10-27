/// <reference lib="dom" />

/**
 * DOM event synthesis shared by the text-field adapters.
 *
 * A dictation has to look like IME input to the page, not like a script writing
 * into a field. Framework code — React's composition handling, ProseMirror's
 * beforeinput pipeline, plain `input` listeners — keys off this event sequence,
 * so it is specified here once and asserted in the tests:
 *
 *   compositionstart
 *   input (insertCompositionText, isComposing: true)   × one per pre-edit update
 *   compositionupdate
 *   … on commit: compositionend(detail) then input(insertText, isComposing: false)
 *   … on cancel: input(deleteCompositionText) then compositionend('')
 */
import type { EditOp } from "../edit/dictation.ts";

export function composeEvent(type: "compositionstart" | "compositionupdate" | "compositionend", data: string): Event {
	if (typeof CompositionEvent === "function") {
		return new CompositionEvent(type, { bubbles: true, data });
	}
	const event = new Event(type, { bubbles: true });
	Object.defineProperty(event, "data", { value: data, enumerable: true });
	return event;
}

export function inputEvent(inputType: string, data: string | null, isComposing: boolean): Event {
	if (typeof InputEvent === "function") {
		return new InputEvent("input", { bubbles: true, inputType, data, isComposing });
	}
	const event = new Event("input", { bubbles: true });
	Object.defineProperties(event, {
		inputType: { value: inputType, enumerable: true },
		data: { value: data, enumerable: true },
		isComposing: { value: isComposing, enumerable: true },
	});
	return event;
}

/** Ops are absolute, so a multi-op batch has to be applied back to front. */
export function descending(ops: readonly EditOp[]): EditOp[] {
	return [...ops].sort((left, right) => right.start - left.start);
}
