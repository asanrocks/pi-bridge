// ============================================================================
// Session actor (ADR 19) — the one owner of one Session's runtime lifetime.
//
// The actor owns exactly one Manager and its canonical Document: command
// admission, observation registration, and terminal teardown all live here,
// behind one phase state machine (creating → live → closing → closed). The
// Manager remains the pi adapter and the Document projector inside the
// actor; every client mutation of the runtime passes through a capability
// the actor issued — raw Manager access belongs to the creation paths
// (the factory, the registry's pre-registration choreography), never to a
// client. The actor is created around a built runtime, so its phase begins
// `live`; `creating` names the pre-registration window the registry owns
// today, which the registry thinning moves inside the actor.
//
// Admission keeps the two classes the bridge has always needed (architecture
// invariant 5: pi's event loop is serial and the bridge observes it):
//
//   - Mutations (setModel, setThinkingLevel, renameSession, setLabel,
//     navigate) are serialized among themselves — one at a time, in
//     admission order — so concurrent commands from different Connections
//     get a deterministic order. Mutations are quick and never await a
//     turn, so the line cannot deadlock behind streaming.
//   - Immediate work (turns — prompt, recoverTurn — plus abort, and reads —
//     pull, gitShow's cwd) runs without queueing: a Stop must reach a
//     streaming turn rather than wait behind it, and a read that queued
//     behind a turn would stall the live pulls the client issues while
//     content streams. It is tracked, so the terminal drain accounts for it.
//
// `close` is the one disposal path — registry collection and daemon shutdown
// both go through it. Admission stops synchronously (phase `closing`), queued
// mutations reject, the Manager is disposed exactly once — its disposal
// aborts and finalizes the in-flight turn (settling the tracked work
// admitted against it) and drains the git-stamp observation scope before the
// runtime goes — and every tracked operation is awaited before `close`
// resolves (phase `closed`). The drain then releases every live observation:
// they owned delivery of the teardown's final patches, and nothing
// registered through a capability outlives the actor's teardown.
//
// This absorbed `session-execution.ts` (admission and the terminal boundary)
// and `session-lease.ts` (the Connection's release guard): the capability is
// the lease's successor, with independently releasable observations and a
// joinable release. The four load-bearing contract properties are pinned in
// test/suite/session-actor.test.ts:
//   - a command admitted by a capability completes against the runtime it
//     captured, even when the capability is released while it runs;
//   - observation release is idempotent and per-observation;
//   - the terminal boundary is joinable — a second caller awaits the same
//     drain, and the runtime is disposed exactly once;
//   - after a release or the terminal boundary nothing is admitted, and no
//     event reaches a released observer.
// ============================================================================

import type { PrefixCursor, SessionRef } from "../core/index.ts";
import type { ActivationAuthorization } from "./activation-registry.ts";
import { createLifecycleScope } from "./lifecycle-scope.ts";
import type { ConnectionHandle, Manager } from "./manager.ts";

/** The phase of one Session actor's lifetime. The registry's address
 * reservation covers `creating`; the actor owns the rest, and `closed` is
 * the joinable drain every later caller observes. */
export type ActorPhase = "creating" | "live" | "closing" | "closed";

/** One observer of one Session's Document: the handle shape the runtime
 * already delivers through — the initial-sync frame at registration, live
 * patches after. The Connection implements this today; the browser's mirror
 * sits behind it. */
export type SessionObserver = ConnectionHandle;

/** One registered observation of one Session. Releasing it removes that
 * observer and nothing else — commands stay admitted and sibling
 * observations keep delivering. The release is idempotent and resolves once
 * the observation is gone. */
export interface ObservationCapability {
	readonly ref: SessionRef;
	release(): Promise<void>;
}

/** One client's handle for one Activation registration: the only path to
 * that Session's runtime. Commands and mutations are admitted by the
 * Session's actor — a command admitted before its registration ended
 * completes against the runtime it captured, so the reply the client trusts
 * describes the session that was attached when the request arrived — and
 * observation registration returns its own independently releasable
 * capability. Everything rejects once the registration ended: release,
 * collection, replacement, or daemon shutdown. */
export interface SessionCapability {
	readonly ref: SessionRef;
	readonly authorization: ActivationAuthorization;
	command<T>(operation: (session: Manager) => Promise<T>): Promise<T>;
	mutate<T>(operation: (session: Manager) => Promise<T>): Promise<T>;
	observe(observer: SessionObserver, cursor: PrefixCursor | null): ObservationCapability;
	release(): Promise<void>;
}

export interface SessionActorOptions {
	/** The runtime this actor owns, already built by the creation path. */
	manager: Manager;
	ref: SessionRef;
	authorization: ActivationAuthorization;
}

export interface SessionActor {
	readonly ref: SessionRef;
	readonly authorization: ActivationAuthorization;
	/** The actor's phase. `closing` is set synchronously when `close` begins;
	 * `closed` holds once the drain settled. */
	readonly phase: ActorPhase;
	/** The owned runtime and its canonical Document. Read access is the
	 * migration seam while the registry and the daemon still derive listing
	 * metadata (streaming flag, session file, creation time) from it; every
	 * mutation goes through a capability. */
	readonly manager: Manager;
	/** Mint one client handle for this registration. Every capability shares
	 * the actor's admission; each releases independently. */
	capability(): SessionCapability;
	/** The terminal boundary: stop admission synchronously, dispose the
	 * runtime exactly once, drain admitted work, release every observation.
	 * Idempotent and joinable: every caller observes the same teardown. */
	close(): Promise<void>;
}

export function createSessionActor(options: SessionActorOptions): SessionActor {
	const { manager, ref, authorization } = options;
	const mutations = createLifecycleScope();
	const tracked = new Set<Promise<unknown>>();
	const liveObservations = new Set<{ stop(): void }>();
	let phase: ActorPhase = "live";
	let closed: Promise<void> | undefined;

	/** One installed observer's stop bookkeeping: idempotent, and visible to
	 * the actor's close so no handle outlives the teardown. */
	const installObservation = (observer: SessionObserver): { stop(): void } => {
		let stopped = false;
		const record = {
			stop() {
				if (stopped) return;
				stopped = true;
				liveObservations.delete(record);
				manager.removeConnection(observer);
			},
		};
		liveObservations.add(record);
		return record;
	};

	const capability = (): SessionCapability => {
		let released = false;
		const owned = new Set<{ stop(): void }>();
		return {
			ref,
			authorization,
			command<T>(operation: (session: Manager) => Promise<T>): Promise<T> {
				if (released || phase !== "live") return Promise.reject(new Error("session is closed"));
				// Admission is promise-shaped: an operation that fails before
				// returning its promise rejects instead of escaping as a
				// synchronous throw (untracked) — the same idiom BridgeClient.call
				// uses for a transport that throws in `send`.
				let started: Promise<T>;
				try {
					started = Promise.resolve(operation(manager));
				} catch (error) {
					return Promise.reject(error instanceof Error ? error : new Error(String(error)));
				}
				const settle = started.then(
					() => undefined,
					() => undefined,
				);
				tracked.add(settle);
				void settle.then(() => tracked.delete(settle));
				return started;
			},
			mutate<T>(operation: (session: Manager) => Promise<T>): Promise<T> {
				if (released || phase !== "live") return Promise.reject(new Error("session is closed"));
				return mutations.run(() => operation(manager));
			},
			observe(observer: SessionObserver, cursor: PrefixCursor | null): ObservationCapability {
				// The registration check is synchronous with the installation: a
				// released capability, or one whose actor began closing, must not
				// install an observer nothing would ever remove.
				if (released || phase !== "live") throw new Error("session is closed");
				manager.addConnection(observer, ref, cursor);
				const record = installObservation(observer);
				owned.add(record);
				return {
					ref,
					release() {
						record.stop();
						owned.delete(record);
						return Promise.resolve();
					},
				};
			},
			release(): Promise<void> {
				if (released) return Promise.resolve();
				released = true;
				for (const record of owned) record.stop();
				owned.clear();
				return Promise.resolve();
			},
		};
	};

	return {
		ref,
		authorization,
		get phase() {
			return phase;
		},
		get manager() {
			return manager;
		},
		capability,
		close(): Promise<void> {
			if (closed !== undefined) return closed;
			// The terminal fact is synchronous: from here on every liveness
			// check refuses the actor even while its disposal is in flight.
			phase = "closing";
			closed = (async () => {
				// Queued mutations reject instead of running against a disposing
				// runtime; the one still running settles first (mutations are
				// quick and never await a turn).
				await mutations.close();
				// Disposal aborts and finalizes the in-flight turn — which is
				// what settles the tracked work admitted against it — and drains
				// the git-stamp observation scope before the runtime goes, with
				// observers still installed so client tabs see the final patches.
				await manager.dispose();
				await Promise.allSettled([...tracked]);
				// Observers are released only after the drain: they owned delivery
				// of the teardown's final patches.
				for (const record of [...liveObservations]) record.stop();
				liveObservations.clear();
				phase = "closed";
			})();
			return closed;
		},
	};
}

/** Test seam: a capability over a hand-built Manager with no registry behind
 * it — always admissible, so tests exercise the Connection protocol and the
 * actor's admission ordering, not the registry. The capability never closes
 * the actor; the caller owns the runtime's disposal. */
export function issueDirectCapability(
	manager: Manager,
	ref: SessionRef,
	authorization: ActivationAuthorization = { incarnation: "test", generation: 1 },
): SessionCapability {
	return createSessionActor({ manager, ref, authorization }).capability();
}
