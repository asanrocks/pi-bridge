/// <reference lib="dom" />

/**
 * The bridge every text-field adapter shares.
 *
 * It owns one thing: turning {@link EditBatch} batches into an IME-shaped DOM
 * event sequence, so page code and editors treat the dictation as composition
 * rather than as a script writing into a field. The adapters only describe how
 * to read a caret and how to replace a range.
 */
import type { EditBatch, EditHost, EditOp } from "../edit/dictation.ts";
import { composeEvent, descending, inputEvent } from "./events.ts";

export interface TextTarget extends EditHost {
	readonly element: HTMLElement;
	/** Document text and caret, captured before {@link DictationEdit.begin}. */
	read(): { text: string; caret: number };
	detach(): void;
}

export interface AttachOptions {
	/**
	 * The page changed the text without us (typing, paste, another script).
	 * Callers cancel the dictation: the span we own is no longer trustworthy.
	 */
	onExternalEdit?: () => void;
}

export interface TargetAdapter {
	readText(): string;
	readCaret(): number;
	/** Apply ops without touching composition state; caret is the implementer's choice. */
	applyOps(ops: readonly EditOp[]): void;
	/**
	 * Replace the span with `text` through the browser's own edit pipeline, so
	 * one undo removes the utterance. Returns false when unavailable.
	 *
	 * An adapter whose field carries a lock (a host that makes its field
	 * read-only during an utterance) must lift it for the duration of this call
	 * and restore it afterwards: browsers refuse the edit command on a read-only
	 * field.
	 */
	nativeReplace(span: { start: number; end: number }, text: string): boolean;
}

export function attach(element: HTMLElement, adapter: TargetAdapter, options: AttachOptions = {}): TextTarget {
	let composing = false;
	/** Set while we dispatch our own events (or run a command that dispatches). */
	let synthetic = false;

	const emit = (event: Event): void => {
		element.dispatchEvent(event);
	};

	const onInput = (): void => {
		if (synthetic) return;
		options.onExternalEdit?.();
	};
	element.addEventListener("input", onInput);

	const target: TextTarget = {
		element,
		read: () => ({ text: adapter.readText(), caret: adapter.readCaret() }),
		detach: () => {
			element.removeEventListener("input", onInput);
		},
		apply: (batch: EditBatch) => {
			switch (batch.kind) {
				case "preedit": {
					if (!composing) {
						composing = true;
						emit(composeEvent("compositionstart", ""));
					}
					synthetic = true;
					adapter.applyOps(descending(batch.ops));
					// Read the span back after applying: the event must describe what the
					// field now shows, not what it showed a moment ago.
					const text = adapter.readText().slice(batch.span.start, batch.span.end);
					emit(inputEvent("insertCompositionText", text, true));
					synthetic = false;
					emit(composeEvent("compositionupdate", text));
					return;
				}
				case "commit": {
					// `compositionend` first, then the text: that is the order the page is
					// documented to see (see events.ts), and the order `execCommand` gives
					// us anyway, since it dispatches its own `input` synchronously.
					const text = adapter.readText().slice(batch.span.start, batch.span.end);
					composing = false;
					emit(composeEvent("compositionend", text));
					synthetic = true;
					const native = adapter.nativeReplace(batch.span, text);
					if (!native) emit(inputEvent("insertText", text, false));
					synthetic = false;
					return;
				}
				case "cancel": {
					synthetic = true;
					adapter.applyOps(descending(batch.ops));
					composing = false;
					emit(inputEvent("deleteCompositionText", null, false));
					emit(composeEvent("compositionend", ""));
					synthetic = false;
					return;
				}
			}
		},
	};

	return target;
}
