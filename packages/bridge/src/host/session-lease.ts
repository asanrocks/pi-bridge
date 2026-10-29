// ============================================================================
// SessionLease — the Connection → Session capability.
//
// A Connection never holds a Session's runtime (the Manager) directly: it
// holds a lease the Activation registry issued for one registration. The
// lease is the only path to the runtime, so ownership is a type property
// instead of a comment — a command runs through `command` or `mutate`,
// observation flows through the handle the lease registered, and a lease
// whose registration ended (collection, replacement, or daemon shutdown)
// rejects instead of reaching a disposed runtime.
//
// The lease does not own the Session's lifetime (the registry does) or the
// order of its work (the SessionExecution does). It owns one attachment: the
// observer handle it installed for the accepting Connection, and the
// admission class every command is issued through. `release` is idempotent
// and is the one way the observer leaves the runtime.
// ============================================================================

import type { PrefixCursor, SessionRef } from "../core/index.ts";
import type { ActivationAuthorization } from "./activation-registry.ts";
import type { ConnectionHandle, Manager } from "./manager.ts";
import { createSessionExecution, type SessionExecution } from "./session-execution.ts";

/** What a lease is issued against: the execution that owns the runtime's
 * work admission, the address identity, and the registration's
 * authorization. Admission is the execution's: commands are rejected once
 * its terminal boundary began. */
export interface SessionLeaseTarget {
	execution: SessionExecution;
	ref: SessionRef;
	authorization: ActivationAuthorization;
}

export interface SessionLease {
	/** The address + identity of the attached session (ADR 11). */
	readonly ref: SessionRef;
	/** The registration this lease was issued for (link incarnation plus
	 * generation): a replaced registration never inherits this lease's
	 * commands, delivery, or attachments. */
	readonly authorization: ActivationAuthorization;
	/** Run one immediate command against the Session runtime — a turn
	 * (prompt, recoverTurn), an abort, or a read (pull, gitShow's cwd). The
	 * registration is checked when the command is admitted; a command
	 * admitted before its registration ended still completes against the
	 * runtime it captured, so the reply the client trusts describes the
	 * session that was attached when the request arrived. */
	command<T>(operation: (session: Manager) => Promise<T>): Promise<T>;
	/** Run one serialized mutation (setModel, setThinkingLevel, rename,
	 * setLabel, navigate): one at a time, in admission order. */
	mutate<T>(operation: (session: Manager) => Promise<T>): Promise<T>;
	/** Install the observer handle on the runtime (this emits the initial
	 * sync). At most once, before `release`. */
	attachObserver(handle: ConnectionHandle, cursor: PrefixCursor | null): void;
	/** Remove the observer and end the lease: commands reject afterwards.
	 * Idempotent. */
	release(): void;
}

export function createSessionLease(target: SessionLeaseTarget): SessionLease {
	let handle: ConnectionHandle | null = null;
	let released = false;
	return {
		ref: target.ref,
		authorization: target.authorization,
		command<T>(operation: (session: Manager) => Promise<T>): Promise<T> {
			if (released) return Promise.reject(new Error("session is closed"));
			return target.execution.run(operation);
		},
		mutate<T>(operation: (session: Manager) => Promise<T>): Promise<T> {
			if (released) return Promise.reject(new Error("session is closed"));
			return target.execution.mutate(operation);
		},
		attachObserver(next: ConnectionHandle, cursor: PrefixCursor | null): void {
			if (released || handle !== null) return;
			handle = next;
			target.execution.observe(next, target.ref, cursor);
		},
		release(): void {
			if (released) return;
			released = true;
			if (handle !== null) {
				target.execution.unobserve(handle);
				handle = null;
			}
		},
	};
}

/** Test seam: a lease for a hand-built Manager with no registry behind it,
 * backed by a real SessionExecution — always admissible, so tests exercise
 * the Connection protocol and the execution's ordering, not the registry. */
export function issueDirectLease(
	manager: Manager,
	ref: SessionRef,
	authorization: ActivationAuthorization = { incarnation: "test", generation: 1 },
): SessionLease {
	return createSessionLease({
		execution: createSessionExecution(manager),
		ref,
		authorization,
	});
}
