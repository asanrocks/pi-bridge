/**
 * Layer 3: bind the editing model to a real text field.
 *
 * One contract: `read()` to capture the caret, then an {@link DictationEdit}
 * whose batches this target applies. The target turns those batches into the
 * IME event sequence the page expects and, where the browser allows it, keeps
 * the commit on the native undo stack.
 *
 * `attach` is exported because it is the seam another field type needs: it owns
 * the event sequence, and an adapter only says how to read a caret and how to
 * replace a range. `attachInput` covers `input` and `textarea`, the shapes a
 * host actually dictates into.
 *
 * Not provided here, on purpose: a React component and adapters for specific
 * rich-text editors. Both are consumers of this contract, and the rich-text
 * ones must go through the editor's own transaction API.
 */

export type { AttachOptions, TargetAdapter, TextTarget } from "./attach.ts";
export { attach } from "./attach.ts";
export { attachInput } from "./input.ts";
export { insertTextWithUndo, supportsNativeUndo } from "./native-undo.ts";
