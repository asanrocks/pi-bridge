// ============================================================================
// textPolish — what a polish changed, as one span.
//
// Polish rewrites the whole draft, so the obvious client is "assign the new
// value". That is the wrong shape for two reasons: the write has to go through
// the field's own editing path (see useDictation's `TextTarget`), and the
// toolbar's undo has to know what to put back.
//
// The service answers with a whole text, but the useful shape is a replacement:
// the changed region is what remains after the common prefix and the common
// suffix. Recording that region *and the text it replaced* — not just the text
// it inserted — is what keeps the undo alive after the user carries on typing
// around it, which is the whole mobile case: no Ctrl+Z, polish, keep writing,
// then take the polish back. A record that held the inserted text only would
// have to verify the entire field and would refuse the moment anything else
// changed, which for a whole-draft rewrite means always.
//
// Both coordinates are UTF-16 code units, matching `String.prototype.slice` and
// the editing model's offsets.
// ============================================================================

/** One replacement, in the *before* document's coordinates. */
export interface TextEdit {
	/** The replaced region. Empty when the edit only inserted. */
	span: { start: number; end: number };
	inserted: string;
	replaced: string;
}

/** The idle row's answer about the last polish attempt. `unchanged` is a real
 * answer — the service considered the text fine as it was — not a failure. */
export type PolishState =
	| { kind: "idle" }
	| { kind: "running" }
	| { kind: "failed"; reason: string }
	| { kind: "unchanged" };

/** The smallest replacement that turns `before` into `after`, or null when they
 * are the same text (nothing to install and nothing to undo). */
export function changedSpan(before: string, after: string): TextEdit | null {
	if (before === after) return null;
	const limit = Math.min(before.length, after.length);

	let start = 0;
	while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;

	// The two scans must not overlap: the middle they would both claim is the
	// region that actually differs.
	let tail = 0;
	while (
		tail < limit - start &&
		before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)
	) {
		tail += 1;
	}

	return {
		span: { start, end: before.length - tail },
		inserted: after.slice(start, after.length - tail),
		replaced: before.slice(start, before.length - tail),
	};
}

/** Where the edit's text sits once it is installed (same start, new length). */
export function installedSpan(edit: TextEdit): { start: number; end: number } {
	return { start: edit.span.start, end: edit.span.start + edit.inserted.length };
}

/** Whether `text` still holds the installed edit, so undoing it would put back
 * what the polish replaced rather than overwrite the user's own text. Offsets
 * before the span are not verified: an edit that moved them fails this check,
 * which is the same limitation the dictation undo carries. */
export function isStillApplied(text: string, edit: TextEdit): boolean {
	const installed = installedSpan(edit);
	return installed.end <= text.length && text.slice(installed.start, installed.end) === edit.inserted;
}
