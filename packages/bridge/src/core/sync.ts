// ============================================================================
// Initial sync construction — pure, browser-safe (ADR 09).
//
// buildInitialSync turns the canonical Document plus pi's file-ordered entry
// list into exactly one wire frame: a delta multi-op patch when the client's
// prefix cursor is valid, otherwise a full replace snapshot. Both frames
// carries the session reference.
//
// Mid-turn pairing rule: pi persists every user/assistant/toolResult message
// at message_end, while the canonical Document holds those entries as
// `pending:*` provisionals until the turn-end reconcile seals them. A
// committed pi entry that still pairs with a provisional is therefore
// represented by that provisional — sending both would double-render, and
// omitting the provisional would break the later seal `move` (the mirror
// must hold the provisional for the move to relocate). Such committed
// entries are excluded until sealed; they receive `ord` and become cacheable
// at the next reconcile or initial sync.
// ============================================================================

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { findProvisional, stripLazyFields, toEntry } from "./document.ts";
import type {
	Document,
	Entry,
	JsonValue,
	PatchMessage,
	PatchOp,
	PrefixCursor,
	ReplaceMessage,
	SessionRef,
} from "./types.ts";

/**
 * Server-side cursor check (ADR 09 §Prefix Cursor). Catches a wrong session,
 * a stale prefix length, and a missing anchor. Not authentication — it does
 * not prove arbitrary client storage contents.
 */
export function validateCursor(piEntries: SessionEntry[], cursor: PrefixCursor, sessionId: string): boolean {
	if (cursor.sessionId !== sessionId) return false;
	if (!Number.isInteger(cursor.entryCount) || cursor.entryCount <= 0) return false;
	if (cursor.entryCount > piEntries.length) return false;
	return piEntries[cursor.entryCount - 1].id === cursor.lastKnownId;
}

interface CommittedProjection {
	id: string;
	ord: number;
	value: Entry;
}

/** Committed entries with ord and lazy fields stripped, in file order. */
function collectCommitted(doc: Document, piEntries: SessionEntry[]): CommittedProjection[] {
	const out: CommittedProjection[] = [];
	for (let i = 0; i < piEntries.length; i++) {
		const piEntry = piEntries[i];
		// Pairing applies only to entries the canonical Document does not
		// already hold. findProvisional's assistant branch pairs by existence of
		// the pending:message singleton, not correspondence — consulting it for
		// known entries would drop every previously committed assistant message
		// during a mid-turn attach (and cost O(n²) in the user branch).
		if (doc.entries[piEntry.id] === undefined && findProvisional(doc.entries, piEntries, piEntry)) {
			continue; // still in-flight
		}
		// Prefer the canonical entry (streaming-enriched); fall back to the
		// file projection — this also discovers silently-appended entries
		// (e.g. setLabel) that no event has delivered yet.
		const base = doc.entries[piEntry.id] ?? toEntry(piEntry);
		out.push({ id: piEntry.id, ord: i, value: stripLazyFields({ ...base, ord: i } as Entry) });
	}
	return out;
}

/** Provisional entries with lazy fields stripped, never cached, no ord. */
function collectProvisional(doc: Document): Array<[string, Entry]> {
	const out: Array<[string, Entry]> = [];
	for (const [id, entry] of Object.entries(doc.entries)) {
		if (id.startsWith("pending:")) out.push([id, stripLazyFields(entry)]);
	}
	return out;
}

/**
 * Build the initial-sync frame. A valid cursor yields one ordinary multi-op
 * patch: adds for the missing committed suffix, adds for current provisional
 * skeletons, and complete status and scoped models. Anything else yields a
 * full replace. The delta always carries at least the two unconditional
 * replaces, so it is never a compact single-append frame (CompactCodec).
 */
export function buildInitialSync(
	doc: Document,
	piEntries: SessionEntry[],
	session: SessionRef,
	cursor: PrefixCursor | null,
): PatchMessage | ReplaceMessage {
	const valid = cursor !== null && validateCursor(piEntries, cursor, session.sessionId);

	if (!valid) {
		const entries: Record<string, Entry> = {};
		for (const committed of collectCommitted(doc, piEntries)) {
			entries[committed.id] = committed.value;
		}
		for (const [id, value] of collectProvisional(doc)) {
			entries[id] = value;
		}
		return {
			kind: "replace",
			session,
			document: { status: doc.status, entries, scopedModels: doc.scopedModels },
		};
	}

	const ops: PatchOp[] = [];
	for (const committed of collectCommitted(doc, piEntries)) {
		if (committed.ord >= cursor.entryCount) {
			ops.push({ op: "add", path: `/entries/${committed.id}`, value: committed.value as unknown as JsonValue });
		}
	}
	for (const [id, value] of collectProvisional(doc)) {
		ops.push({ op: "add", path: `/entries/${id}`, value: value as unknown as JsonValue });
	}
	ops.push({ op: "replace", path: "/status", value: doc.status as unknown as JsonValue });
	ops.push({ op: "replace", path: "/scopedModels", value: doc.scopedModels as unknown as JsonValue });
	return { kind: "patch", session, ops };
}
