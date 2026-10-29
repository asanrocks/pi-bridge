// ============================================================================
// sessionCandidate — the ADR 09 candidate document for a live session
// switch, as pure functions.
//
// While an openSession RPC is in flight, the connection is still subscribed
// to the old session: old-session patches (including teardown finals) may
// arrive before the switch. The client therefore seeds the target session
// into a candidate document instead of the active mirror; old-session
// patches keep updating the active mirror, and the target initial-sync
// frame (identified by its sessionId) applies to the candidate. Promotion
// is atomic: the candidate becomes the mirror only when its initial sync
// has applied.
//
// The candidate itself is the navigation reactor's transition state — seeded
// by the step of the opening transition (from message-carried cache records)
// and consumed by the step of its promoting initial-sync frame. There is no
// module-level registry: whoever seeds it is the step, by construction.
// ============================================================================

import { applyPatch, type Document, type PatchOp } from "../../../../src/core/index.ts";

export interface SessionCandidate {
	sessionId: string;
	doc: Document;
}

/**
 * Apply an initial-sync delta patch to the candidate and promote it:
 * returns `{ before, doc }` when the frame's sessionId matches the
 * candidate; null when it differs — the caller then treats the frame as a
 * plain barrier. `before` is the pre-promotion seed document; cache
 * write-through must plan against it (not the store's old-session document)
 * so only the delta's new entries are persisted — cross-session documents
 * share no entry references. Pure: consuming the candidate (nulling the
 * transition's slot) is the caller's step.
 */
export function promoteCandidate(
	candidate: SessionCandidate,
	sessionId: string,
	ops: PatchOp[],
): { before: Document; doc: Document } | null {
	if (candidate.sessionId !== sessionId) return null;
	return { before: candidate.doc, doc: applyPatch(candidate.doc, ops) };
}
