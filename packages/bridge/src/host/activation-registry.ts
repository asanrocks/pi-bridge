// ============================================================================
// Activation registry — the index and reservation layer around the Session
// actors.
//
// A Session actor owns its runtime's lifetime: admission, observations,
// terminal teardown, and the idle-collection decision (its live
// capabilities, its streaming state, and the policy delays). The registry
// owns what is addressed rather than run: the Activation records, the
// address index, in-flight creation reservations, the durable session-id
// ownership index, the Connection-to-Activation attachment index, and the
// collection choreography — index cleanup and the terminal
// `session_closed` notifications — once an actor ends (idle, close, or
// shutdown).
//
//   absent → creating → live → collecting → absent
//
// describes the *address*: creation for one address is shared (concurrent
// opens join the same promise), collection holds the address reserved until
// the actor's close and the cleanup both complete (a concurrent open waits
// and retries rather than creating a second Manager for a session whose
// first is still shutting down), and the durable session id can be claimed
// by only one (Project, stem) address.
//
// The registry does not serve assets, scan session files, or broadcast: the
// daemon supplies hooks for the pushes and the Manager factory.
// ============================================================================

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { SessionRef } from "../core/index.ts";
import type { Manager } from "./manager.ts";
import type { ProjectConfig } from "./projects.ts";
import { createSessionActor, type SessionActor, type SessionAdmission } from "./session-actor.ts";

/** Address key: (projectId, stem) — the client-facing address of a Session. */
export function addressKey(projectId: string, stem: string): string {
	return `${projectId}\0${stem}`;
}

/** The registration's authorization identity: this registry's incarnation
 * (one daemon run) plus the registration's generation within it. Work
 * composed against a registration names this pair, so a replaced
 * registration never inherits its predecessor's commands, delivery, or
 * attachments. In this in-process link a new generation is always a new
 * Manager and a new attachment. */
export interface ActivationAuthorization {
	readonly incarnation: string;
	readonly generation: number;
}

/** One live Activation: a Manager, its attached Connections, and its claims. */
export interface ActivationRecord {
	id: string;
	ref: SessionRef;
	/** This registration's authorization identity (see above). */
	authorization: ActivationAuthorization;
	/** The one owner of this Session's runtime lifetime: admission,
	 * observation registration, and terminal disposal all go through it. The
	 * record holds it; listing reads go through `actor.metadata()`, never the
	 * runtime itself. */
	actor: SessionActor;
	/** The registration-scoped admission the Worker admits target-addressed
	 * commands through. It owns no observation and no client liveness, so it
	 * cannot keep the Activation alive; it rejects once the actor began
	 * closing. */
	admission: SessionAdmission;
	/** In-flight registration disposal (the actor's close plus this
	 * registry's index cleanup); null once it completes. Transient
	 * bookkeeping, never a state: the actor's phase is the terminal fact, and
	 * this promise is the join every later `collect` caller and every
	 * reservation awaits — cleared only when the disposal completed, so the
	 * join window is exactly its lifetime. */
	collecting: Promise<void> | null;
}

export interface ActivationRegistryOptions {
	/** This registry's incarnation: the identity a registration's generation
	 * is scoped to (one daemon run for the in-process link). */
	incarnation: string;
	/** Create the Manager for a session file. Throws when creation fails. */
	createManager: (project: ProjectConfig, stem: string, abs: string) => Promise<Manager>;
	/** Idle GC delay for a durable or empty session. */
	idleGcMs: number;
	/** Idle GC delay for an entry-bearing unflushed session, whose disposal
	 * can drop entries that never reached disk. */
	unflushedIdleGcMs: number;
	/** A session settled (its file may have just been written). */
	onSettled: (ref: SessionRef) => void;
	/** A live Activation's streaming flag changed. */
	onStreamingChange: () => void;
	/** A live Activation's activity phase changed (the process title's source). */
	onActivityChange?: () => void;
	/** An Activation was registered or finished collecting. */
	onRegistryChange: () => void;
	/** An Activation's indexes are gone: its address and durable-id claims are
	 * released. The Worker ends the observations it installed on the record
	 * here — after the actor's close delivered the teardown's final patches,
	 * and before `collect` resolves, so a close reply implies the client was
	 * told the runtime is gone. */
	onCollected?: (record: ActivationRecord) => void;
}

export class ActivationRegistry {
	/** Live and collecting activations by daemon-local id. */
	private records = new Map<string, ActivationRecord>();
	/** Manager-owning operations in flight that no address key covers yet
	 * (fresh-session creation); the shutdown drain awaits them. */
	private creations = new Set<Promise<unknown>>();
	/** Activation id by (projectId, stem) address. */
	private byAddress = new Map<string, string>();
	/** In-flight creation promises by address: concurrent opens share one. */
	private pending = new Map<string, Promise<ActivationRecord>>();
	/** The durable session id ownership index (ADR 11): the claiming
	 * registration's record id alongside its address, so a release is by
	 * record identity — a stale record can never release a newer
	 * registration's claim even when the address fields match. */
	private sessionOwnerById = new Map<string, { recordId: string; projectId: string; stem: string }>();
	/** Monotonic registration counter: a generation is never reused within
	 * the registry's incarnation. */
	private generations = 0;
	/** Terminal state: set synchronously at the top of dispose(), so no
	 * admission can interleave with the drain. */
	private disposed = false;
	/** The memoized shutdown drain: a second `dispose()` joins the first
	 * caller's drain instead of returning as if shutdown had finished —
	 * `disposed` answers "has shutdown begun", this promise answers "has it
	 * completed", and only the latter may gate follow-up work (moving a
	 * session file, reporting a clean stop). */
	private disposeDrain: Promise<void> | null = null;
	private options: ActivationRegistryOptions;

	constructor(options: ActivationRegistryOptions) {
		this.options = options;
	}

	// ── Queries ───────────────────────────────────────────────────────────

	/** True once shutdown began: no activation is admitted anymore. */
	get isDisposed(): boolean {
		return this.disposed;
	}

	/** The live (non-collecting) Activation for an address, if any. */
	byAddressLive(projectId: string, stem: string): ActivationRecord | undefined {
		const id = this.byAddress.get(addressKey(projectId, stem));
		if (id === undefined) return undefined;
		const record = this.records.get(id);
		return record !== undefined && record.actor.phase === "live" ? record : undefined;
	}

	/** The Activation for an address, including one mid-collection. */
	byAddressAny(projectId: string, stem: string): ActivationRecord | undefined {
		const id = this.byAddress.get(addressKey(projectId, stem));
		return id === undefined ? undefined : this.records.get(id);
	}

	/** All live (non-collecting) Activations. */
	live(): ActivationRecord[] {
		const out: ActivationRecord[] = [];
		for (const record of this.records.values()) {
			if (record.actor.phase === "live") out.push(record);
		}
		return out;
	}

	// ── Creation ──────────────────────────────────────────────────────────

	/**
	 * Reserve the Activation for `(projectId, stem)`: an existing live
	 * Activation (cancelling its GC timer), an in-flight creation, or a new
	 * Activation. A collecting Activation is awaited and the reservation
	 * retried, so a GC racing an open never disposes a reattached session.
	 */
	async reserve(project: ProjectConfig, stem: string, abs: string): Promise<ActivationRecord> {
		const key = addressKey(project.id, stem);
		for (;;) {
			// Shutdown stops admission — including a retry that resumes after a
			// collected Activation finished during the drain.
			if (this.disposed) throw new Error("daemon is shutting down");
			const existingId = this.byAddress.get(key);
			if (existingId !== undefined) {
				const record = this.records.get(existingId);
				// The actor's phase is the liveness fact. The capability the
				// following attach mints cancels the actor's idle timer (and the
				// fire-time re-check covers the window).
				if (record && record.actor.phase === "live") return record;
				if (record?.collecting) {
					await record.collecting;
					continue;
				}
			}
			const pending = this.pending.get(key);
			if (pending) return pending;

			const promise = this.create(project, stem, abs);
			this.pending.set(key, promise);
			try {
				return await promise;
			} finally {
				this.pending.delete(key);
			}
		}
	}

	/**
	 * The address's record once no creation is in flight for it: live or
	 * collecting, or undefined when the address holds nothing.
	 *
	 * Address-mutating operations (close, archive) must see pending creation:
	 * acting on the registered state alone could report "not active" — or
	 * move the session file — while a Manager for that address is still being
	 * constructed, and the completing creation would then register or attach
	 * against an address whose lifetime had already been decided.
	 */
	async awaitSettled(projectId: string, stem: string): Promise<ActivationRecord | undefined> {
		const key = addressKey(projectId, stem);
		for (;;) {
			const pending = this.pending.get(key);
			if (pending === undefined) break;
			// A failed creation settles too; the recheck below sees whatever the
			// address holds afterwards.
			await pending.catch(() => {});
		}
		const id = this.byAddress.get(key);
		return id === undefined ? undefined : this.records.get(id);
	}

	/**
	 * Open an address for an observation: reserve, then confirm the record is
	 * still live, as one operation. A close or a kill can collect the reserved
	 * record between the reservation resolving and the caller installing its
	 * observation — observing a collected record would pin a disposed runtime —
	 * so the open re-reserves until it holds a live one.
	 */
	async open(project: ProjectConfig, stem: string, abs: string): Promise<ActivationRecord> {
		for (;;) {
			const record = await this.reserve(project, stem, abs);
			if (record.actor.phase === "live") return record;
		}
	}

	private async create(project: ProjectConfig, stem: string, abs: string): Promise<ActivationRecord> {
		if (!existsSync(abs)) throw new Error(`No such session: ${stem}`);
		const manager = await this.options.createManager(project, stem, abs);
		const sessionId = manager.liveSessionId;
		const owner = this.sessionOwnerById.get(sessionId);
		if (owner && (owner.projectId !== project.id || owner.stem !== stem)) {
			await manager.dispose();
			throw new Error(`Session id is already addressed as ${owner.projectId}/${owner.stem}`);
		}
		return this.register(manager, { projectId: project.id, sessionId, stem });
	}

	/** Register an already-created Manager under its address.
	 *
	 * Owns the Manager from the moment it is called: if shutdown has begun, it
	 * disposes the Manager and refuses — an Activation registered after the
	 * drain's snapshot would be owned by nobody. The disposal is awaited, not
	 * fire-and-forget: the caller is a tracked creation (reserve's pending
	 * promise, or a `runCreation` operation), and the drain awaits those, so
	 * the Manager is gone before the drain can return.
	 */
	async register(manager: Manager, ref: SessionRef): Promise<ActivationRecord> {
		if (this.disposed) {
			await manager.dispose();
			throw new Error("daemon is shutting down");
		}
		const authorization: ActivationAuthorization = {
			incarnation: this.options.incarnation,
			generation: ++this.generations,
		};
		// The actor owns the idle decision (its live capabilities and streaming
		// state, with the registry's policy delays) and observes its own
		// runtime's settlement and streaming transitions, relaying the daemon's
		// broadcast hooks; the registry owns the collection choreography once
		// the actor says it is idle.
		let record: ActivationRecord | undefined;
		const actor = createSessionActor({
			manager,
			ref,
			authorization,
			idleGcMs: this.options.idleGcMs,
			unflushedIdleGcMs: this.options.unflushedIdleGcMs,
			onIdle: () => {
				if (record !== undefined) void this.collect(record);
			},
			onSettled: () => this.options.onSettled(ref),
			onStreamingChange: () => this.options.onStreamingChange(),
			onActivityChange: () => this.options.onActivityChange?.(),
		});
		record = {
			id: randomUUID(),
			ref,
			authorization,
			actor,
			admission: actor.admission(),
			collecting: null,
		};
		const registered = record;
		this.records.set(registered.id, registered);
		this.byAddress.set(addressKey(ref.projectId, ref.stem), registered.id);
		this.sessionOwnerById.set(ref.sessionId, {
			recordId: registered.id,
			projectId: ref.projectId,
			stem: ref.stem,
		});

		this.options.onRegistryChange();
		return registered;
	}

	// ── Creation tracking ────────────────────────────────────────────────

	/**
	 * Run one Manager-owning operation under shutdown tracking. Fresh-session
	 * creation builds a Manager whose address is not known until the Manager
	 * has allocated its file, so it cannot sit in the per-address pending map
	 * the drain already covers — but it must not outlive the drain either. The
	 * drain awaits the operation, and the operation owns its cleanup: a
	 * registration refused because shutdown began disposes the Manager it
	 * produced inside the tracked promise.
	 */
	async runCreation<T>(op: () => Promise<T>): Promise<T> {
		const promise = (async () => op())();
		this.creations.add(promise);
		try {
			return await promise;
		} finally {
			this.creations.delete(promise);
		}
	}

	// ── Collection ────────────────────────────────────────────────────────

	/**
	 * Dispose `record` under its `collecting` reservation. Reached from the
	 * actor's idle decision (onIdle, after its eligibility checks) and the
	 * explicit closeSession verb (no eligibility checks — a close is a
	 * user-initiated kill, so streaming state and attachments do not defer
	 * it).
	 */
	async collect(record: ActivationRecord): Promise<void> {
		// A disposal already in flight is joined, not re-entered: `collecting`
		// is cleared only when the disposal completed, so awaiting it is
		// exactly "wait until this record finished dying". Callers gate
		// follow-up work on this (archiveSession moves the session file only
		// after the Manager finished flushing), so an early return here would
		// let them act on a runtime that is still tearing down.
		if (record.collecting !== null) {
			await record.collecting;
			return;
		}
		// Records that existed when shutdown began are disposed by the drain;
		// records registered after it are refused. Either way this call owns
		// nothing, and acting would double-dispose.
		if (this.disposed) return;
		// The actor's phase is the terminal fact: a registration whose actor
		// began closing owns nothing — not the address, not the durable-id
		// claim. A stale handle reaching here (a close that raced an idle
		// collection, a caller holding a replaced registration) is refused
		// instead of re-entering disposal, so it can neither double-dispose the
		// runtime nor release a newer registration's claims.
		if (record.actor.phase !== "live") return;
		// disposeRecord invokes the actor's close synchronously before its
		// first await, so the phase flips to `closing` before any caller can
		// interleave — the terminal fact is set without a separate flag.
		record.collecting = this.disposeRecord(record).finally(() => {
			record.collecting = null;
			this.options.onRegistryChange();
		});
		await record.collecting;
	}

	private async disposeRecord(record: ActivationRecord): Promise<void> {
		// Dispose first, then release the address. Releasing it before disposal
		// would let a concurrent openSession create a second activation for a
		// session whose first Manager is still shutting down, violating the
		// ADR 11 exclusivity invariant. The address (and its pending-open
		// promise) stays reserved for the whole disposal. The actor's close
		// rejects admission synchronously, drains the mutation line, disposes
		// the runtime exactly once, awaits the tracked work, and releases every
		// observation.
		await record.actor.close();
		this.records.delete(record.id);
		const key = addressKey(record.ref.projectId, record.ref.stem);
		if (this.byAddress.get(key) === record.id) this.byAddress.delete(key);
		// Released by record identity, not address fields: only the record
		// that still holds the claim releases it, so a stale record (already
		// ended, its disposal raced by a replacement registration) can never
		// delete a newer registration's claim.
		const owner = this.sessionOwnerById.get(record.ref.sessionId);
		if (owner && owner.recordId === record.id) {
			this.sessionOwnerById.delete(record.ref.sessionId);
		}
		// The addresses are gone; the Worker ends the observations it installed
		// on this registration here. The actor's close already delivered the
		// teardown's final patches (its observers were still installed) and
		// released the handles, so this is the terminal `closed` notification a
		// client needs to stop waiting for a runtime that no longer exists —
		// delivered before `collect` resolves, hence before a close reply.
		this.options.onCollected?.(record);
	}

	/**
	 * Stop serving and drain. Idempotent: every caller joins the same drain.
	 *
	 * The terminal flag is set and every index is cleared in one synchronous
	 * block, so no admission can interleave with the snapshot: a record is
	 * either in it (and its Manager is disposed here, or by a collection the
	 * drain awaits), or it is refused. Creation promises already in flight are
	 * awaited — their register call refuses and disposes the Manager it
	 * produced — so a factory that completes after shutdown can neither
	 * register an Activation nor leak one.
	 */
	dispose(): Promise<void> {
		if (this.disposeDrain !== null) return this.disposeDrain;
		this.disposed = true;
		const closing: ActivationRecord[] = [];
		const draining: Promise<unknown>[] = [];
		for (const record of this.records.values()) {
			// A mid-collection activation already owns its disposal; awaiting it
			// avoids a concurrent double-dispose, then it drops out of the map.
			// An idle actor's pending timer is cleared by its own close — the
			// drain invokes it below.
			if (record.collecting) draining.push(record.collecting);
			else closing.push(record);
		}
		// In-flight creations: they settle (register refuses and disposes the
		// Manager) before this returns, so nothing can appear after shutdown.
		// The per-address pending map covers opens of existing sessions;
		// `creations` covers fresh-session creation, whose address does not
		// exist until the Manager allocated its file.
		draining.push(...this.pending.values());
		draining.push(...this.creations);
		this.records.clear();
		this.byAddress.clear();
		this.pending.clear();
		this.sessionOwnerById.clear();
		this.disposeDrain = (async () => {
			await Promise.allSettled(draining);
			// Every remaining actor closes here (its own observers receive the
			// final patches), and the Worker ends their observations after it,
			// exactly as a collection does — no stream outlives the drain.
			for (const record of closing) {
				await record.actor.close();
				this.options.onCollected?.(record);
			}
		})();
		return this.disposeDrain;
	}
}
