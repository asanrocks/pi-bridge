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

import { existsSync } from "node:fs";
import type { PrefixCursor, SessionRef } from "../core/index.ts";
import type { ActivationAuthorization } from "./activation-registry.ts";
import { createLifecycleScope } from "./lifecycle-scope.ts";
import type { ConnectionHandle, Manager } from "./manager.ts";

/** Idle-collection policy defaults (ADR 11): a durable or empty session is
 * collected after five idle minutes; an entry-bearing unflushed session only
 * after thirty, because disposing it can drop entries that never reached
 * disk. The registry passes the daemon's configured values; these defaults
 * cover direct construction. */
export const DEFAULT_IDLE_GC_MS = 5 * 60_000;
export const DEFAULT_UNFLUSHED_IDLE_GC_MS = 30 * 60_000;

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
	/** Idle-collection delays (ADR 11 daemon policy; defaults above). */
	idleGcMs?: number;
	unflushedIdleGcMs?: number;
	/** The actor became idle: no live capability holds it, it is neither
	 * streaming nor compacting, and the policy delay elapsed. The registry's
	 * collection choreography — never invoked once `close` began. */
	onIdle?: () => void;
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
	 * the actor's admission; each releases independently. A live capability
	 * is an attached client and keeps the actor alive (glossary A.6). */
	capability(): SessionCapability;
	/** Arm the idle timer for a registration that never attached a client
	 * (an orphaned creation whose Connection closed mid-transition): the
	 * count-based arming only fires when a live capability leaves. */
	armIdle(): void;
	/** The terminal boundary: stop admission synchronously, dispose the
	 * runtime exactly once, drain admitted work, release every observation.
	 * Idempotent and joinable: every caller observes the same teardown. */
	close(): Promise<void>;
}

export function createSessionActor(options: SessionActorOptions): SessionActor {
	const { manager, ref, authorization } = options;
	const idleGcMs = options.idleGcMs ?? DEFAULT_IDLE_GC_MS;
	const unflushedIdleGcMs = options.unflushedIdleGcMs ?? DEFAULT_UNFLUSHED_IDLE_GC_MS;
	const onIdle = options.onIdle;
	const mutations = createLifecycleScope();
	const tracked = new Set<Promise<unknown>>();
	const liveObservations = new Set<{ stop(): void }>();
	/** Live (unreleased) capabilities: a held capability is an attached
	 * client, which keeps the actor alive and cancels idle collection
	 * (glossary A.6 — attached Connections keep an Activation alive). */
	let liveCapabilities = 0;
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	let phase: ActorPhase = "live";
	let closed: Promise<void> | undefined;

	const cancelIdle = (): void => {
		if (idleTimer !== null) {
			clearTimeout(idleTimer);
			idleTimer = null;
		}
	};

	/** Arm the idle timer under the ADR 11 policy: a durable or empty session
	 * waits `idleGcMs`; an unflushed session that already has entries waits
	 * the longer `unflushedIdleGcMs`. No-ops while a capability is live or the
	 * actor is not live — and the fire-time re-check covers the races. */
	const armIdle = (): void => {
		if (phase !== "live" || liveCapabilities > 0 || idleTimer !== null) return;
		const durable = existsSync(manager.sessionFile);
		const empty = Object.keys(manager.document.entries).length === 0;
		idleTimer = setTimeout(
			() => {
				idleTimer = null;
				void maybeCollect();
			},
			durable || empty ? idleGcMs : unflushedIdleGcMs,
		);
	};

	/** The idle decision: re-check at fire time (a capability attached or a
	 * close began since the timer was armed owns the decision now), defer
	 * while the runtime is streaming or compacting, then hand the collection
	 * to the registry's choreography. */
	const maybeCollect = async (): Promise<void> => {
		if (phase !== "live" || liveCapabilities > 0) return;
		const status = manager.document.status;
		if (status.isStreaming || status.isCompacting) {
			armIdle();
			return;
		}
		onIdle?.();
	};

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
		liveCapabilities++;
		cancelIdle();
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
				liveCapabilities--;
				// The last client left: the actor's own lifetime decision begins.
				if (liveCapabilities === 0) armIdle();
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
		armIdle,
		close(): Promise<void> {
			if (closed !== undefined) return closed;
			// The terminal fact is synchronous: from here on every liveness
			// check refuses the actor even while its disposal is in flight.
			phase = "closing";
			cancelIdle();
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
