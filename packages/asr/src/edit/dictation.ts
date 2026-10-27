/**
 * Layer 2: the editing model between wire events and a text field.
 *
 * A dictation is not an append. The server rewrites its transcript while it
 * listens (text shrinks, gets re-punctuated, moves), so the only durable
 * abstraction is "a span of the host document that this dictation owns and may
 * replace wholesale". Everything here is expressed as edits against that span,
 * which keeps the layer free of DOM and makes it testable as plain functions.
 *
 * Deliberate v1 scope: one commit policy. The server provides no reliable "this
 * segment is settled" signal (docs/protocol.md §6.5), so the whole utterance
 * stays a pre-edit and becomes one commit — one undo group — at the terminal
 * message.
 */
import { AsrError } from "../errors.ts";

/** Offsets are UTF-16 code units, matching `String.prototype.slice`. */
export interface EditOp {
	start: number;
	end: number;
	text: string;
}

export type EditKind = "preedit" | "commit" | "cancel";

/**
 * A batch of changes, plus what the host should do with them:
 *
 * - `preedit`: apply `ops`; the text is provisional and will be replaced.
 * - `commit`: `ops` is empty — the current pre-edit became durable. Close the
 *   composition and record one undo step covering everything since `preedit`
 *   began for this group.
 * - `cancel`: apply `ops` (removals); drop the composition and any undo step
 *   recorded for this group.
 */
export interface EditBatch {
	/** Increments once per committed utterance; the unit of undo/redo. */
	group: number;
	kind: EditKind;
	/**
	 * The document region this dictation owns after the batch is applied. Hosts
	 * need it to select the pre-edit (native-undo commit) and to place the caret.
	 */
	span: { start: number; end: number };
	ops: EditOp[];
}

/**
 * How a batch was resolved, for hosts that want to branch on it.
 *
 * - `applied`: the batch is in the document (a pre-edit, or a committed one).
 * - `cancelled`: an empty final result, so the pre-edit was removed instead.
 * - `dropped`: the document no longer held this dictation's span, so nothing was
 *   written; the host's text is authoritative and was left alone.
 */
export type EditOutcome = "applied" | "cancelled" | "dropped";

/**
 * The host side of the contract. A text field, a store document or a test
 * double all implement this.
 *
 * `read` is optional and is the difference between a host that trusts itself and
 * one that cannot be trusted: with it, the model verifies that its span still
 * contains the pre-edit before every write and drops the dictation instead of
 * overwriting text someone else changed. Text-field targets in `@earendil-works/pi-asr/dom`
 * already provide it; a store or any other string document should return its
 * current text here. Without it the model assumes it is the only writer, and an
 * external edit silently shifts every later diff.
 */
export interface EditHost {
	apply(batch: EditBatch): void;
	read?: () => { text: string };
}

interface Commit {
	start: number;
	text: string;
}

/**
 * `idle` before the first `begin`, `active` while a dictation owns its span,
 * `ended` after a commit or a cancel, `abandoned` when the document was changed
 * under us. The last two differ only in intent: both ignore the rest of the
 * utterance instead of throwing from inside an event loop.
 */
type Phase = "idle" | "active" | "ended" | "abandoned";

export class DictationEdit {
	private readonly host: EditHost;
	/** Absolute offset of the first character this dictation owns. */
	private anchor = 0;
	/** The provisional text currently in the document. */
	private text = "";
	private group = 0;
	private phase: Phase = "idle";
	private readonly commits: Commit[] = [];

	constructor(host: EditHost) {
		this.host = host;
	}

	get isActive(): boolean {
		return this.phase === "active";
	}

	/** What the document should show for this dictation right now. */
	get preview(): string {
		return this.text;
	}

	/** Begin a dictation at `offset`, captured from the host's caret. */
	begin(offset: number): void {
		if (this.phase === "active") {
			throw new AsrError("config", "edit: begin() while a dictation is active");
		}
		if (!Number.isInteger(offset) || offset < 0) {
			throw new AsrError("config", `edit: invalid offset ${String(offset)}`);
		}
		this.anchor = offset;
		this.text = "";
		this.group += 1;
		this.phase = "active";
	}

	/**
	 * Replace the visible text with the server's latest track-0 text.
	 *
	 * The diff is minimal (common prefix and suffix), so a re-punctuated or
	 * shortened transcript becomes a small in-place edit instead of a full
	 * delete/insert. That is what keeps the caret and the host's undo stack sane.
	 *
	 * A late result after the dictation ended is normal (the server keeps sending
	 * until the socket closes), so a model that is no longer active reports
	 * `dropped` rather than throwing from inside an event loop. Calling it before
	 * the first `begin` is still misuse and throws.
	 */
	update(text: string): EditOutcome {
		this.requireProceedable();
		if (this.phase !== "active") return "dropped";
		if (this.drifted()) {
			this.abandon();
			return "dropped";
		}
		if (text === this.text) return "applied";
		const op = diffReplace(this.text, text, this.anchor);
		if (op !== null) {
			this.host.apply({
				group: this.group,
				kind: "preedit",
				span: { start: this.anchor, end: this.anchor + text.length },
				ops: [op],
			});
		}
		this.text = text;
		return "applied";
	}

	/** Terminal message: the pre-edit becomes one durable, undoable edit. */
	commit(text: string): EditOutcome {
		this.requireProceedable();
		if (this.phase !== "active") return "dropped";
		if (this.drifted()) {
			this.abandon();
			return "dropped";
		}
		if (text.length === 0) {
			// Silence: there is nothing to commit, so the pre-edit is removed whole
			// rather than left behind as an empty composition.
			this.cancel();
			return "cancelled";
		}
		const outcome = this.update(text);
		if (outcome !== "applied") return outcome;
		this.host.apply({
			group: this.group,
			kind: "commit",
			span: { start: this.anchor, end: this.anchor + this.text.length },
			ops: [],
		});
		this.commits.push({ start: this.anchor, text: this.text });
		this.anchor += this.text.length;
		this.text = "";
		this.phase = "ended";
		return "applied";
	}

	/**
	 * Drop everything this dictation added. Used for cancellation, transport
	 * failure, and "the user edited the document elsewhere".
	 *
	 * When the span is gone, the removals are skipped: the document is already the
	 * user's, and deleting at stale offsets would eat text that is not ours.
	 */
	cancel(): void {
		if (this.phase !== "active") return;
		const drifted = this.drifted();
		const span = { start: this.anchor, end: this.anchor + this.text.length };
		this.host.apply({
			group: this.group,
			kind: "cancel",
			span,
			ops: this.text.length > 0 && !drifted ? [{ start: span.start, end: span.end, text: "" }] : [],
		});
		this.text = "";
		this.phase = "ended";
	}

	/**
	 * Reverse the last committed utterance. Returns the batch to apply, or null
	 * when there is nothing left. Hosts with a native undo stack use this to keep
	 * their own history authoritative; hosts without one apply it directly.
	 */
	revertLast(): EditBatch | null {
		const last = this.commits.pop();
		if (last === undefined) return null;
		// Reversing at stale offsets is the same corruption as an update, so a
		// document that no longer matches means there is nothing safe to revert.
		if (this.host.read !== undefined) {
			const { text } = this.host.read();
			if (text.slice(last.start, last.start + last.text.length) !== last.text) return null;
		}
		this.group += 1;
		this.anchor = last.start;
		this.text = "";
		this.phase = "ended";
		const span = { start: last.start, end: last.start + last.text.length };
		return { group: this.group, kind: "cancel", span, ops: [{ ...span, text: "" }] };
	}

	/** True when the document no longer holds this dictation's pre-edit. */
	private drifted(): boolean {
		if (this.host.read === undefined || this.text.length === 0) return false;
		// Method call on the host, not a detached function: `read` may use `this`.
		return this.host.read().text.slice(this.anchor, this.anchor + this.text.length) !== this.text;
	}

	/**
	 * Let go without removing: close the composition, keep no state, and ignore the
	 * rest of this utterance's results.
	 */
	private abandon(): void {
		this.host.apply({
			group: this.group,
			kind: "cancel",
			span: { start: this.anchor, end: this.anchor + this.text.length },
			ops: [],
		});
		this.text = "";
		this.phase = "abandoned";
	}

	/** `update`/`commit` before any `begin` is misuse; after one it is a race. */
	private requireProceedable(): void {
		if (this.phase === "idle") throw new AsrError("config", "edit: no active dictation");
	}
}

/**
 * Apply a batch to plain text.
 *
 * This is the whole host side for a document that is a string rather than the
 * DOM: a React store, a model buffer, a test double. `span` says where the caret
 * belongs afterwards; the text itself comes from `ops`, applied back to front
 * because they are absolute offsets and a batch may carry more than one.
 *
 * Pair the host with `read` (see {@link EditHost}) or the model cannot tell that
 * someone else changed the text, and a stale offset silently rewrites the wrong
 * range. Oper offsets are checked: a batch that does not fit the document is a
 * programming error, not something to splice anyway.
 */
export function applyBatch(text: string, batch: EditBatch): string {
	let result = text;
	const ordered = [...batch.ops].sort((left, right) => right.start - left.start);
	for (const op of ordered) {
		if (!fits(result, op)) {
			throw new AsrError(
				"config",
				`edit: batch op [${String(op.start)}, ${String(op.end)}) does not fit a ${String(result.length)}-unit document`,
			);
		}
		result = result.slice(0, op.start) + op.text + result.slice(op.end);
	}
	return result;
}

function fits(text: string, op: EditOp): boolean {
	return (
		Number.isInteger(op.start) &&
		Number.isInteger(op.end) &&
		op.start >= 0 &&
		op.end >= op.start &&
		op.end <= text.length
	);
}

/**
 * Minimal replacement turning `previous` into `next`, in absolute offsets.
 *
 * Returns null when the strings are equal. Prefix and suffix are trimmed on
 * code-point boundaries so a replacement never splits a surrogate pair.
 */
export function diffReplace(previous: string, next: string, offset: number): EditOp | null {
	if (previous === next) return null;
	const prefix = commonPrefixLength(previous, next);
	const suffix = commonSuffixLength(previous, next, prefix);
	return {
		start: offset + prefix,
		end: offset + previous.length - suffix,
		text: next.slice(prefix, next.length - suffix),
	};
}

function commonPrefixLength(a: string, b: string): number {
	const limit = Math.min(a.length, b.length);
	let index = 0;
	while (index < limit && a.charCodeAt(index) === b.charCodeAt(index)) index += 1;
	if (index > 0 && index < a.length && splitsPair(a, index)) index -= 1;
	return index;
}

function commonSuffixLength(a: string, b: string, prefix: number): number {
	const limit = Math.min(a.length, b.length) - prefix;
	let index = 0;
	while (index < limit && a.charCodeAt(a.length - 1 - index) === b.charCodeAt(b.length - 1 - index)) {
		index += 1;
	}
	const boundary = a.length - index;
	if (index > 0 && boundary > prefix && splitsPair(a, boundary)) index -= 1;
	return index;
}

/** True when cutting `value` at `index` would separate a surrogate pair. */
function splitsPair(value: string, index: number): boolean {
	const before = value.charCodeAt(index - 1);
	const after = value.charCodeAt(index);
	return isHighSurrogate(before) && isLowSurrogate(after);
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}
