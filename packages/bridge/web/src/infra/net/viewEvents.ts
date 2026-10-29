// ============================================================================
// viewEvents — the typed observation events the browser view actor consumes
// (ADR 19).
//
// The view actor is the one owner of the committed view, the pending
// transition, the cache candidate, the route, and store publication. The
// transport pipeline decodes wire pushes and delivers them to that actor as
// these values; it does not decide whether an event becomes visible, and it
// never writes navigation-owned state (the cache base, the route, the store
// publication).
//
// Every event carries the **view generation** — the identity of the
// attachment whose observation produced it. A late frame from an older
// attachment (a superseded open, a socket lost mid-open, a reattach to the
// same address) must not update the successor's view even when it names the
// same address, and the check is one comparison: the event's generation
// equals the generation the actor committed. A newer generation is not the
// actor's to apply either — the transition that owns it advances the
// committed generation, and that attachment's initial sync is its commit
// barrier.
// ============================================================================

import type { PatchOp, SessionRef } from "../../../../src/core/index.ts";

/** Identifies one attachment's observation stream on one connection: minted
 * per attach, so a frame can be attributed to the attachment that produced
 * it even when the address is unchanged. */
export type ViewGeneration = number;

/** One observation event, delivered by the transport pipeline to the view
 * actor. `initial_sync` is the commit barrier (a full replace when `ops` is
 * null, a cursor-aware delta otherwise; `operationId` is present when a
 * newSession transition emitted the frame); `patch` is a live delta;
 * `session_closed` is the host's terminal ownership push for an address. */
export type ViewObservationEvent =
	| {
			kind: "initial_sync";
			generation: ViewGeneration;
			ref: SessionRef;
			ops: PatchOp[] | null;
			operationId?: string;
	  }
	| { kind: "patch"; generation: ViewGeneration; ops: PatchOp[] }
	| { kind: "session_closed"; generation: ViewGeneration; projectId: string; stem: string };

/** The generation an event was produced by. */
export function viewGeneration(event: ViewObservationEvent): ViewGeneration {
	return event.generation;
}

/** True while an event belongs to the committed attachment. The comparison is
 * equality, not ordering: an older generation is a stale frame the actor
 * drops, and a newer one arrives before the transition that owns it has
 * committed — its own initial sync carries it. */
export function isCurrentGeneration(current: ViewGeneration, event: ViewObservationEvent): boolean {
	return event.generation === current;
}
