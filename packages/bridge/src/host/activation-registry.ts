// ============================================================================
// Activation registry — the one owner of live-Activation state.
//
// An Activation is the live runtime of exactly one Session: one Manager, the
// Connections attached to it, and the exclusive claims that keep the address
// and the durable session id single-owner. The registry owns every state
// transition of that lifetime:
//
//   absent → creating → live → collecting → absent
//
// Creation for one address is shared (concurrent opens join the same
// promise), collection holds the address reserved until disposal completes
// (a concurrent open waits and retries rather than creating a second Manager
// for a session whose first is still shutting down), and the durable session
// id can be claimed by only one (Project, stem) address.
//
// The registry does not serve assets, scan session files, or broadcast: the
// daemon supplies hooks for the pushes and the Manager factory.
// ============================================================================

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { PrefixCursor, SessionRef } from "../core/index.ts";
import type { Connection } from "./connection.ts";
import type { Manager } from "./manager.ts";
import type { ProjectConfig } from "./projects.ts";

/** Address key: (projectId, stem) — the client-facing address of a Session. */
export function addressKey(projectId: string, stem: string): string {
	return `${projectId}\0${stem}`;
}

/** One live Activation: a Manager, its attached Connections, and its claims. */
export interface ActivationRecord {
	id: string;
	ref: SessionRef;
	manager: Manager;
	/** Attached Connections. GC is gated on this being empty. */
	connections: Set<Connection>;
	gcTimer: ReturnType<typeof setTimeout> | null;
	collecting: Promise<void> | null;
	lastStreaming: boolean;
}

export interface ActivationRegistryOptions {
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
	/** An Activation was registered or finished collecting. */
	onRegistryChange: () => void;
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
	/** The durable session id ownership index (ADR 11). */
	private sessionOwnerById = new Map<string, { projectId: string; stem: string }>();
	/** The Connection → Activation attachment index. */
	private connectionActivation = new Map<Connection, ActivationRecord>();
	/** Terminal state: set synchronously at the top of dispose(), so no
	 * admission can interleave with the drain. */
	private disposed = false;
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
		return record !== undefined && record.collecting === null ? record : undefined;
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
			if (record.collecting === null) out.push(record);
		}
		return out;
	}

	/** The Activation a Connection is attached to, if any. */
	attachmentOf(conn: Connection): ActivationRecord | undefined {
		return this.connectionActivation.get(conn);
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
				if (record && record.collecting === null) {
					this.cancelGc(record);
					return record;
				}
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
	 * Open an address for a Connection: reserve, then attach, as one
	 * operation. A close or a kill can collect the reserved record between
	 * the reservation resolving and the attach — attaching a collected record
	 * would pin a disposed Manager — so the open re-reserves until it holds a
	 * live one. The check and the attach are one synchronous block, so nothing
	 * can interleave between them.
	 */
	async open(
		conn: Connection,
		project: ProjectConfig,
		stem: string,
		abs: string,
		cursor: PrefixCursor | null,
	): Promise<ActivationRecord> {
		for (;;) {
			const record = await this.reserve(project, stem, abs);
			if (record.collecting !== null) continue;
			this.attach(conn, record, cursor);
			return record;
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
		const record: ActivationRecord = {
			id: randomUUID(),
			ref,
			manager,
			connections: new Set(),
			gcTimer: null,
			collecting: null,
			lastStreaming: manager.document.status.isStreaming,
		};
		this.records.set(record.id, record);
		this.byAddress.set(addressKey(ref.projectId, ref.stem), record.id);
		this.sessionOwnerById.set(ref.sessionId, { projectId: ref.projectId, stem: ref.stem });

		manager.onSettled(() => this.options.onSettled(ref));
		manager.onPatch(() => {
			const streaming = manager.document.status.isStreaming;
			if (streaming !== record.lastStreaming) {
				record.lastStreaming = streaming;
				this.options.onStreamingChange();
			}
		});

		this.options.onRegistryChange();
		return record;
	}

	// ── Attachment ────────────────────────────────────────────────────

	/**
	 * Run one Manager-owning operation under shutdown tracking. Fresh-session
	 * creation (the daemon's newSession) builds a Manager whose address is not
	 * known until the Manager has allocated its file, so it cannot sit in the
	 * per-address pending map the drain already covers — but it must not
	 * outlive the drain either. The drain awaits the operation, and the
	 * operation owns its cleanup: a registration refused because shutdown
	 * began disposes the Manager it produced inside the tracked promise.
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
	// ── Attachment ────────────────────────────────────────────────────────────

	attach(conn: Connection, record: ActivationRecord, cursor: PrefixCursor | null): void {
		if (this.disposed) throw new Error("daemon is shutting down");
		// A collected record owns nothing anymore: attaching it would pin a
		// disposed Manager with a Connection nothing would release. Callers that
		// can retry (open) re-reserve instead.
		if (record.collecting !== null) throw new Error("session is closing");
		// A socket that closed while its openSession/newSession RPC was in
		// flight: the close handler already ran (and released nothing — the
		// connection was not yet attached), so attaching now would pin the
		// activation forever with an unreleasable Connection. Arm GC instead;
		// the orphaned activation collects on the normal idle path.
		if (conn.isDisposed) {
			this.armGc(record);
			return;
		}
		this.release(conn);
		conn.attach(record.manager, record.ref, cursor);
		record.connections.add(conn);
		this.connectionActivation.set(conn, record);
		this.cancelGc(record);
	}

	/** Release a Connection's attachment; arm GC when it was the last one. */
	release(conn: Connection): void {
		const record = this.connectionActivation.get(conn);
		if (!record) return;
		this.connectionActivation.delete(conn);
		record.connections.delete(conn);
		if (record.connections.size === 0) this.armGc(record);
	}

	// ── Collection ────────────────────────────────────────────────────────

	armGc(record: ActivationRecord): void {
		if (this.disposed) return;
		if (record.gcTimer !== null || record.collecting !== null) return;
		if (record.connections.size > 0) return;
		const durable = existsSync(record.manager.sessionFile);
		const empty = Object.keys(record.manager.document.entries).length === 0;
		const delay = durable || empty ? this.options.idleGcMs : this.options.unflushedIdleGcMs;
		record.gcTimer = setTimeout(() => {
			record.gcTimer = null;
			void this.maybeCollect(record);
		}, delay);
	}

	private cancelGc(record: ActivationRecord): void {
		if (record.gcTimer !== null) {
			clearTimeout(record.gcTimer);
			record.gcTimer = null;
		}
	}

	private async maybeCollect(record: ActivationRecord): Promise<void> {
		if (record.collecting !== null || record.connections.size > 0) return;
		const status = record.manager.document.status;
		if (status.isStreaming || status.isCompacting) {
			this.armGc(record);
			return;
		}
		await this.collect(record);
	}

	/**
	 * Dispose `record` under its `collecting` reservation. Shared by idle GC
	 * (via maybeCollect, after eligibility checks) and the explicit
	 * closeSession verb (no eligibility checks — a close is a user-initiated
	 * kill, so streaming state and attachments do not defer it).
	 */
	async collect(record: ActivationRecord): Promise<void> {
		// Records that existed when shutdown began are disposed by the drain;
		// records registered after it are refused. Either way this call owns
		// nothing, and acting would double-dispose.
		if (this.disposed) return;
		if (record.collecting !== null) {
			await record.collecting;
			return;
		}
		this.cancelGc(record);
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
		// promise) stays reserved for the whole disposal.
		await record.manager.dispose();
		this.records.delete(record.id);
		const key = addressKey(record.ref.projectId, record.ref.stem);
		if (this.byAddress.get(key) === record.id) this.byAddress.delete(key);
		const owner = this.sessionOwnerById.get(record.ref.sessionId);
		if (owner && owner.projectId === record.ref.projectId && owner.stem === record.ref.stem) {
			this.sessionOwnerById.delete(record.ref.sessionId);
		}
		// Sever the Connection→activation mappings so a later detach/release on
		// a still-attached Connection cannot arm GC on the disposed activation.
		// The Connections keep their last-received document (ADR 11 defers a
		// per-attachment death push) until they navigate or reconnect.
		for (const conn of record.connections) {
			this.connectionActivation.delete(conn);
		}
		record.connections.clear();
	}

	/**
	 * Stop serving and drain. Idempotent.
	 *
	 * The terminal flag is set and every index is cleared in one synchronous
	 * block, so no admission can interleave with the snapshot: a record is
	 * either in it (and its Manager is disposed here, or by a collection the
	 * drain awaits), or it is refused. Creation promises already in flight are
	 * awaited — their register call refuses and disposes the Manager it
	 * produced — so a factory that completes after shutdown can neither
	 * register an Activation nor leak one.
	 */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const managers: Manager[] = [];
		const draining: Promise<unknown>[] = [];
		for (const record of this.records.values()) {
			if (record.gcTimer) clearTimeout(record.gcTimer);
			// A mid-collection activation already owns its disposal; awaiting it
			// avoids a concurrent double-dispose, then it drops out of the map.
			if (record.collecting) draining.push(record.collecting);
			else managers.push(record.manager);
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
		this.connectionActivation.clear();
		await Promise.allSettled(draining);
		for (const mgr of managers) {
			await mgr.dispose();
		}
	}
}
