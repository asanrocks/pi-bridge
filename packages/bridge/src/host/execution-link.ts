// ============================================================================
// ExecutionLink — the seam between the Daemon and Session execution.
//
// The Daemon owns configuration, catalogues, scanning, broadcasts, and the
// HTTP/WebSocket surface; everything that runs a Session — the Activation
// registry, Manager creation, and the per-session command choreography —
// sits behind this interface. The local implementation is in-process; a
// remote implementation (a Worker process over a socket) can implement the
// same contract without the Daemon branching on locality.
//
// Every Activation registration carries an authorization: this link's
// incarnation plus the registration's generation within it. Work composed
// against a registration names that pair, so a replaced registration never
// inherits its predecessor's commands, delivery, or attachments. In the
// local link a new generation is always a new Manager and a new attachment;
// the pair is the identity a remote link checks its late replies against.
// ============================================================================

import { randomUUID } from "node:crypto";
import type { ImageContent, ModelRef, PrefixCursor, SessionRef } from "../core/index.ts";
import { type ActivationRecord, ActivationRegistry } from "./activation-registry.ts";
import type { Connection } from "./connection.ts";
import type { createManager, Manager } from "./manager.ts";
import { type ProjectConfig, stemFromSessionPath } from "./projects.ts";

/** Injectable Manager factory (the Daemon's test seam). */
export type ManagerFactory = (opts: Parameters<typeof createManager>[0]) => Promise<Manager>;

export interface ExecutionLinkOptions {
	/** Create a Manager resuming the durable session file at `abs`. Throws
	 * when creation fails. */
	openManager: (project: ProjectConfig, abs: string) => Promise<Manager>;
	/** Create a Manager for a fresh (initially unflushed) session in
	 * `project`. */
	createManager: (project: ProjectConfig) => Promise<Manager>;
	/** Idle GC delay for a durable or empty session. */
	idleGcMs: number;
	/** Idle GC delay for an entry-bearing unflushed session, whose disposal
	 * can drop entries that never reached disk. */
	unflushedIdleGcMs: number;
	/** The thinking level a fresh session on a picked model resolves to
	 * before clamping (the Daemon's Project-settings read). */
	requestedThinkingLevel: (projectId: string, provider: string, modelId: string) => string;
	/** A session settled (its file may have just been written). */
	onSettled: (ref: SessionRef) => void;
	/** A live Activation's streaming flag changed. */
	onStreamingChange: () => void;
	/** An Activation was registered or finished collecting. */
	onRegistryChange: () => void;
}

export interface ExecutionLink {
	/** This link's identity: one daemon run for the local link. */
	readonly incarnation: string;
	/** Resolve-or-create the Activation for an address and attach `conn`:
	 * a collecting Activation is awaited, an in-flight creation is shared,
	 * and a close that lands mid-open is re-reserved rather than attached. */
	open(
		conn: Connection,
		project: ProjectConfig,
		stem: string,
		abs: string,
		cursor: PrefixCursor | null,
	): Promise<ActivationRecord>;
	/** Create a fresh Session in `project` and attach `conn`. The first
	 * prompt is admitted server-side before the attach (ADR 12); a refused
	 * admission or an unknown model disposes the fresh activation, so no
	 * empty session survives. */
	create(
		conn: Connection,
		project: ProjectConfig,
		text: string,
		options?: { images?: ImageContent[]; model?: ModelRef; thinkingLevel?: string },
	): Promise<ActivationRecord>;
	/** The address's record once no creation is in flight for it — live or
	 * collecting, or undefined when the address holds nothing. Address-
	 * mutating operations (close, archive) must see pending creation. */
	awaitSettled(projectId: string, stem: string): Promise<ActivationRecord | undefined>;
	/** The Activation for an address, including one mid-collection. */
	byAddressAny(projectId: string, stem: string): ActivationRecord | undefined;
	/** Kill one Activation (a close, not a GC): disposal ignores idle policy,
	 * streaming state, and attachments. Every attached Connection is detached
	 * and receives a `session_closed` push (the terminal ownership boundary). */
	collect(record: ActivationRecord): Promise<void>;
	/** Release a Connection's attachment (the detach verb and socket close). */
	release(conn: Connection): void;
	/** Live (non-collecting) activations — listing overlays. */
	live(): ActivationRecord[];
	/** Stop admitting and drain: creations, collections, and every remaining
	 * Manager are settled or disposed before this resolves. */
	dispose(): Promise<void>;
}

export function createLocalExecutionLink(options: ExecutionLinkOptions): ExecutionLink {
	const incarnation = randomUUID();
	const registry = new ActivationRegistry({
		incarnation,
		createManager: (project, _stem, abs) => options.openManager(project, abs),
		idleGcMs: options.idleGcMs,
		unflushedIdleGcMs: options.unflushedIdleGcMs,
		onSettled: options.onSettled,
		onStreamingChange: options.onStreamingChange,
		onRegistryChange: options.onRegistryChange,
	});

	return {
		incarnation,
		open: (conn, project, stem, abs, cursor) => registry.open(conn, project, stem, abs, cursor),

		create: async (conn, project, text, opts) => {
			const { images, model, thinkingLevel } = opts ?? {};
			// The whole Manager-owning phase — creation, registration, and the
			// pre-attach choices — runs as one registry-tracked creation, so a
			// factory that completes after shutdown began is disposed inside the
			// operation the shutdown drain awaits. Fresh-session creation has no
			// address key until the Manager allocated its file, so it cannot ride
			// the per-address pending map opens use.
			//
			// This is the pre-live window ADR 19 sanctions (see the Session actor
			// header): the runtime has no owner to admit work through until the
			// actor exists, so the stem derivation and the pre-attach choices run
			// on the raw Manager here. Everything after `register` goes through
			// the actor — the record's capability is the only attachment path.
			const activation = await registry.runCreation(async () => {
				const manager = await options.createManager(project);
				let stem: string;
				try {
					stem = stemFromSessionPath(project.sessionDir, manager.sessionFile);
				} catch (err) {
					await manager.dispose();
					throw err;
				}
				if (registry.byAddressAny(project.id, stem) !== undefined) {
					await manager.dispose();
					throw new Error(`Session already active: ${stem}`);
				}
				const record = await registry.register(manager, {
					projectId: project.id,
					sessionId: manager.liveSessionId,
					stem,
				});
				// Pre-session choices from the Project home (ADR 12 slice): apply the
				// picked model and thinking level, then admit the first prompt (with
				// its attachments) before the attach — the client's initial sync
				// carries the in-flight turn on the chosen model, and no empty
				// session exists while the user types. A refused admission or
				// unknown model (no model, no auth) disposes the fresh activation —
				// nothing empty survives to idle-collect later. Patches streamed
				// between admission and attach are covered by the initial sync (the
				// Document is canonical).
				try {
					if (model) {
						await manager.setModel(model.provider, model.modelId);
						// A model pick without an explicit level must resolve like a fresh
						// session on the picked model — the level the Project home
						// displayed. `setModel` would otherwise re-derive the level as
						// `perModel ?? settings default ?? current`, where `current` is the
						// placeholder default model's already-clamped level (the session
						// was created on it) — leaking that model's clamp (e.g. a default
						// model that runs `medium` as `high`) into the picked model.
						if (thinkingLevel === undefined) {
							const level = options.requestedThinkingLevel(project.id, model.provider, model.modelId);
							await manager.setThinkingLevel(level);
						}
					}
					if (thinkingLevel) await manager.setThinkingLevel(thinkingLevel);
					await manager.promptAdmitted(text, images);
				} catch (err) {
					// Registry-owned disposal: a no-op once shutdown began, because
					// the drain already owns the record it snapshotted.
					await registry.collect(record);
					throw err;
				}
				return record;
			});
			registry.attach(conn, activation, null);
			return activation;
		},

		awaitSettled: (projectId, stem) => registry.awaitSettled(projectId, stem),

		byAddressAny: (projectId, stem) => registry.byAddressAny(projectId, stem),

		collect: (record) => registry.collect(record),

		release: (conn) => {
			registry.release(conn);
			conn.detach();
		},

		live: () => registry.live(),

		dispose: () => registry.dispose(),
	};
}
