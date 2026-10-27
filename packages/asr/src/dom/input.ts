/// <reference lib="dom" />

/**
 * `input` / `textarea` adapter.
 *
 * Edits go through `setRangeText`, which keeps `value` and the selection
 * consistent without rebuilding the field. Dispatching `input` afterwards is
 * what tells React (and anything else with a value tracker) that the field
 * changed: the tracker compares against the DOM value and fires `onChange`, so
 * a controlled component sees the dictation as ordinary typing.
 */
import type { EditOp } from "../edit/dictation.ts";
import type { AttachOptions, TextTarget } from "./attach.ts";
import { attach } from "./attach.ts";
import { descending } from "./events.ts";
import { insertTextWithUndo, supportsNativeUndo } from "./native-undo.ts";

export function attachInput(element: HTMLInputElement | HTMLTextAreaElement, options: AttachOptions = {}): TextTarget {
	return attach(
		element,
		{
			readText: () => element.value,
			readCaret: () => element.selectionStart ?? element.value.length,
			applyOps: (ops: readonly EditOp[]) => {
				for (const op of descending(ops)) {
					// 'end' leaves the caret after the dictation, which is where a user
					// expects it while speaking.
					element.setRangeText(op.text, op.start, op.end, "end");
				}
			},
			nativeReplace: (span, text) => {
				if (!supportsNativeUndo(element.ownerDocument)) return false;
				element.focus();
				// The pre-edit was written with `setRangeText`, which never enters the
				// browser's undo stack. Handing the commit to `insertText` with the
				// pre-edit still selected would record "replace X with X": undo would
				// put back the text it just removed, which the user sees as a dead
				// Ctrl+Z. Clearing it first restores the pre-dictation text, so the one
				// command that follows is the whole utterance's undo step.
				element.setRangeText("", span.start, span.end, "end");
				element.setSelectionRange(span.start, span.start);
				// A host may lock the field while the utterance runs, so nothing can be
				// typed into the span the dictation owns. Browsers refuse the edit
				// command on a read-only field, and the transcript would then reach the
				// field through the fallback with no undo step. The lift lasts one
				// synchronous command, so no input can arrive while it is writable.
				const wasReadOnly = element.readOnly;
				element.readOnly = false;
				try {
					if (insertTextWithUndo(element.ownerDocument, text)) return true;
					// The command was refused (an embedded webview, a detached field): the
					// text has to be there anyway, and the caller's synthetic `input`
					// event must describe what is on screen.
					element.setRangeText(text, span.start, span.start, "end");
					return false;
				} finally {
					element.readOnly = wasReadOnly;
				}
			},
		},
		options,
	);
}
