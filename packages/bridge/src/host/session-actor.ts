// ============================================================================
// Session actor contracts (ADR 19) — the seam the actor refactor targets.
//
// Three lifetimes run through the bridge — a Session's runtime, a
// Connection's transport, and the browser's committed view — and each is
// currently spread across several owners whose state must agree after every
// await. The refactor gives each lifetime one actor: a serialized owner
// built on the reactor primitive, whose every transition is one applied
// message, whose asynchronous completions return as ordinary messages, and
// whose close is the joinable terminal drain. This module defines the
// Session actor's outward contract and, until the actor exists, adapts it
// onto the current machinery — SessionExecution owns admission and disposal,
// the registry owns registration — so nothing here changes behavior: the
// Connection keeps its lease, and these types are the target seam the
// characterization tests pin.
//
// The contract's four load-bearing properties (pinned in
// test/suite/actor-contracts.test.ts):
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
import type { ConnectionHandle, Manager } from "./manager.ts";
import type { SessionLeaseTarget } from "./session-lease.ts";

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
 * Session's execution — a command admitted before its registration ended
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

/** The capability adapter: the contract over today's machinery. The target
 * shape is the lease's (`SessionLeaseTarget`); the Session actor becomes the
 * target during the refactor, and this factory keeps its name and seam so
 * the characterization tests survive the swap. */
export function createSessionCapability(target: SessionLeaseTarget): SessionCapability {
	const { execution, ref } = target;
	let released = false;
	const observations = new Set<ObservationCapability>();

	const observationFor = (observer: SessionObserver): ObservationCapability => {
		let stopped = false;
		const observation: ObservationCapability = {
			ref,
			release() {
				if (stopped) return Promise.resolve();
				stopped = true;
				observations.delete(observation);
				execution.unobserve(observer);
				return Promise.resolve();
			},
		};
		return observation;
	};

	return {
		ref,
		authorization: target.authorization,
		command<T>(operation: (session: Manager) => Promise<T>): Promise<T> {
			if (released) return Promise.reject(new Error("session is closed"));
			return execution.run(operation);
		},
		mutate<T>(operation: (session: Manager) => Promise<T>): Promise<T> {
			if (released) return Promise.reject(new Error("session is closed"));
			return execution.mutate(operation);
		},
		observe(observer: SessionObserver, cursor: PrefixCursor | null): ObservationCapability {
			// The registration check is synchronous with the installation: a
			// released capability, or one whose terminal boundary began, must not
			// install an observer nothing would ever remove.
			if (released || execution.ended) throw new Error("session is closed");
			execution.observe(observer, ref, cursor);
			const observation = observationFor(observer);
			observations.add(observation);
			return observation;
		},
		release(): Promise<void> {
			if (released) return Promise.resolve();
			released = true;
			for (const observation of observations) void observation.release();
			observations.clear();
			return Promise.resolve();
		},
	};
}
