/// <reference lib="dom" />

/**
 * Native undo bridge.
 *
 * `document.execCommand('insertText')` is deprecated, and it is still the only
 * way to make a programmatic edit join the browser's own undo stack: assigning
 * `value`, `setRangeText`, and `Range.insertNode` all bypass it, so Ctrl+Z in a
 * text field would not remove what we just dictated.
 *
 * The call is isolated here so the deprecation is one suppressed line with one
 * explanation, and so replacing it (when the EditContext API is usable for
 * dictation) is a one-file change. Every caller must treat "unsupported" as a
 * normal outcome, not an error: some embedded webviews have no such method, and
 * the DOM tests supply or withhold it deliberately.
 *
 * Joining the stack is only half of the contract. Undo restores the text a
 * command *replaced*, so a pre-edit written outside the stack (`setRangeText`,
 * `Range.insertNode`) has to be removed outside the stack first — otherwise the
 * commit replaces the transcript with itself and one Ctrl+Z visibly does
 * nothing. Each adapter owns that half; see `input.ts`.
 */

type ExecCommand = (command: string, showUI?: boolean, value?: string) => boolean;

/**
 * Looked up dynamically so the deprecated symbol is not referenced statically:
 * the type checker flags direct calls, and this is one of the few legitimate
 * uses left.
 */
function execCommandOf(document: Document): ExecCommand | undefined {
	const candidate: unknown = Reflect.get(document, "execCommand");
	if (typeof candidate !== "function") return undefined;
	return (candidate as ExecCommand).bind(document);
}

export function supportsNativeUndo(document: Document): boolean {
	return execCommandOf(document) !== undefined;
}

/**
 * Insert `text` at the current selection using the document's own edit
 * pipeline. Returns false when the runtime has no `execCommand`.
 */
export function insertTextWithUndo(document: Document, text: string): boolean {
	const run = execCommandOf(document);
	return run === undefined ? false : run("insertText", false, text);
}
