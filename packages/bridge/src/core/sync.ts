// ============================================================================
// Initial sync construction — pure, browser-safe (ADR 09).
//
// buildInitialSync turns the canonical Document plus pi's file-ordered entry
// list into exactly one wire frame: a delta multi-op patch when the client's
// prefix cursor is valid, otherwise a full replace snapshot. Both frames
// carries the session reference.
//
// Identity rule: pi reserves a message's entry id before it is visible, so a
// mid-turn Document and the persisted entry list agree on the same key. There
// is no pairing step: a persisted entry is preferred over the live form of the
// same id, and an entry pi has not stored yet travels as its live form.
// ============================================================================

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { projectEntry, stripLazyFields } from "./document.ts";
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
import { isEntrySealed } from "./types.ts";

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
		// The file is authoritative for an entry it holds. A sealed entry is
		// already that projection; an unsealed one is a live form, so sending it
		// would advertise a file position for content the Session has replaced.
		// This also discovers silently-appended entries (e.g. setLabel).
		const existing = doc.entries[piEntry.id];
		const base = existing !== undefined && isEntrySealed(existing) ? existing : projectEntry(piEntry, i);
		out.push({ id: piEntry.id, ord: i, value: stripLazyFields(base) });
	}
	return out;
}

/** Live forms with lazy fields stripped: never cached, no ord. */
function collectProvisional(doc: Document): Array<[string, Entry]> {
	const out: Array<[string, Entry]> = [];
	for (const [id, entry] of Object.entries(doc.entries)) {
		if (!isEntrySealed(entry)) out.push([id, stripLazyFields(entry)]);
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
		// A live form whose entry arrived is already represented by the committed
		// projection; only genuinely in-flight entries are added here.
		for (const [id, value] of collectProvisional(doc)) {
			entries[id] ??= value;
		}
		return {
			kind: "replace",
			session,
			document: { status: doc.status, entries },
		};
	}

	const ops: PatchOp[] = [];
	const committedIds = new Set<string>();
	for (const committed of collectCommitted(doc, piEntries)) {
		committedIds.add(committed.id);
		if (committed.ord >= cursor.entryCount) {
			ops.push({ op: "add", path: `/entries/${committed.id}`, value: committed.value as unknown as JsonValue });
		}
	}
	for (const [id, value] of collectProvisional(doc)) {
		if (committedIds.has(id)) continue;
		ops.push({ op: "add", path: `/entries/${id}`, value: value as unknown as JsonValue });
	}
	ops.push({ op: "replace", path: "/status", value: doc.status as unknown as JsonValue });
	return { kind: "patch", session, ops };
}
