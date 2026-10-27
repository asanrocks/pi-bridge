/**
 * The host for a document that is a string.
 *
 * A store-backed composer cannot hand the model a DOM element: its text lives in
 * application state, and writing to the field directly would fight the store on
 * the next render. Layer 2 already accepts that shape — `EditHost` is
 * `apply(batch)` plus an optional `read()` — so this is only the stateful
 * wrapper around {@link applyBatch}, with the two details a host must get right:
 *
 * - the caret follows the batch (after the pre-edit, after the commit, back to
 *   the start of the removed text on cancel), so `Dictation` can read it from
 *   `read()` and no `caret()` option is needed;
 * - `setText` is how the *user* wins. A store whose text changed without us must
 *   call it, or the model's drift check cannot see the edit and an absolute
 *   offset rewrites the wrong range.
 *
 * What this does not do is undo. A native undo stack belongs to the field; a
 * store-owned host has none, so `DictationEdit.revertLast()` is its only way
 * back and the caller decides what a Ctrl+Z means.
 */
import type { EditBatch, EditHost } from "./dictation.ts";
import { applyBatch } from "./dictation.ts";

export interface StringHostState {
	text: string;
	/** Where the next dictation starts. The caller owns it between dictations. */
	caret: number;
}

export interface StringEditHostOptions {
	/**
	 * Called after every batch and every {@link StringEditHost.setText}, with the
	 * new state. A React store's setter goes here; keep it synchronous.
	 */
	onChange?: (state: StringHostState) => void;
}

export class StringEditHost implements EditHost {
	private current: StringHostState;
	private readonly onChange: ((state: StringHostState) => void) | undefined;

	constructor(state: StringHostState, options: StringEditHostOptions = {}) {
		this.current = { text: state.text, caret: state.caret };
		this.onChange = options.onChange;
	}

	get text(): string {
		return this.current.text;
	}

	get caret(): number {
		return this.current.caret;
	}

	/** Document text and caret, in the shape `Dictation` reads a caret from. */
	read(): { text: string; caret: number } {
		return this.current;
	}

	/** The user changed the document: typing, paste, a new selection. */
	setText(text: string, caret = this.current.caret): void {
		this.write({ text, caret });
	}

	apply(batch: EditBatch): void {
		const text = applyBatch(this.current.text, batch);
		// The caret is the batch's, not the document's: a pre-edit leaves it after
		// the transcript, a commit leaves it there too, and a cancel gives the space
		// back, so it belongs where the removed text started.
		const caret = batch.kind === "cancel" ? batch.span.start : batch.span.end;
		this.write({ text, caret });
	}

	private write(state: StringHostState): void {
		this.current = state;
		this.onChange?.(state);
	}
}
