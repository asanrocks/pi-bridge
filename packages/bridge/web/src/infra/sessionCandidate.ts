// ============================================================================
// sessionCandidate — the ADR 09 candidate mirror for live session switches.
//
// While a switchSession/switchInstance RPC is in flight, the connection is
// still subscribed to the old session: old-session patches (including
// teardown finals) may arrive before the rebind. The client therefore seeds
// the target session into a candidate document instead of the active mirror;
// old-session patches keep updating the active mirror, and the target
// initial-sync frame (identified by its sessionId) updates the candidate.
// Promotion is atomic: the candidate becomes the mirror only when its
// initial sync has applied.
//
// Module-level singleton (the client.ts pattern): useRpc initiates the
// switch, useConnection's onPush consumes the frames. Only one switch may be
// in flight — a second request while a candidate is pending is ignored
// (serial-switch rule).
// ============================================================================

import { applyPatch, type Document, type PatchOp } from "../../../src/core/index.ts";

export interface SessionCandidate {
	sessionId: string;
	doc: Document;
}

let candidate: SessionCandidate | null = null;

/** Seed a candidate for a pending switch. */
export function beginSessionCandidate(sessionId: string, doc: Document): void {
	candidate = { sessionId, doc };
}

/** A switch is in flight — new switch requests must not start. */
export function sessionCandidatePending(): boolean {
	return candidate !== null;
}

/**
 * Apply an initial-sync delta patch to the candidate and promote it:
 * returns `{ before, doc }` when the frame's sessionId matches the pending
 * candidate (clearing it); null when no candidate is pending or the session
 * differs — the caller then treats the frame as a plain barrier. `before`
 * is the pre-promotion seed document; cache write-through must plan against
 * it (not the store's old-session document) so only the delta's new entries
 * are persisted — cross-session documents share no entry references.
 */
export function promoteSessionCandidate(sessionId: string, ops: PatchOp[]): { before: Document; doc: Document } | null {
	if (candidate === null || candidate.sessionId !== sessionId) return null;
	const before = candidate.doc;
	const doc = applyPatch(before, ops);
	candidate = null;
	return { before, doc };
}

/** Drop a pending candidate (RPC failure, no-op switch, instance exit). */
export function discardSessionCandidate(): void {
	candidate = null;
}
