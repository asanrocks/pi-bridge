// ============================================================================
// Local Worker — the in-process implementation of the Worker service contract.
//
// It is the execution half of the host: Project configuration, Session
// storage, the Activation registry, pi runtimes, and the Session actors. The
// Daemon half (browser Connections, HTTP, delivery) reaches it only through
// `WorkerService`, so the process boundary is a deployment choice: a remote
// implementation would speak the same values over a socket.
//
// An **observation** is one Document sync of one target. Installing one mints
// an actor capability (the counted liveness signal that keeps the Activation
// alive) and an observation handle over the Manager's patch stream; releasing
// it removes that handle and the capability, and nothing else. The registry
// owns addressing; the worker owns the observation table and ends an
// Activation's observations when its indexes are gone.
//
// Commands are target-addressed: `admissionFor` resolves the target's address
// to the record still holding that activation generation and durable session
// id, and admits through the record's registration-scoped admission. A target
// whose Activation was replaced is refused — never retargeted at the
// successor — which is what lets a remote link trust its own late work.
// ============================================================================

import { randomUUID } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	filterPatchForSocket,
	type PrefixCursor,
	type PullRequestItem,
	type SessionInfo,
	type SessionListCursor,
} from "../core/index.ts";
import { type ActivationRecord, ActivationRegistry } from "./activation-registry.ts";
import type { ConnectionHandle, createManager, Manager } from "./manager.ts";
import {
	archiveStemFile,
	normalizeStem,
	type ProjectConfig,
	resolveStemPath,
	stemFromSessionPath,
} from "./projects.ts";
import {
	DEFAULT_IDLE_GC_MS,
	DEFAULT_UNFLUSHED_IDLE_GC_MS,
	type ObservationCapability,
	type SessionAdmission,
	type SessionCapability,
} from "./session-actor.ts";
import { assertNoSessionIdConflicts, type CatalogLiveEntry, createSessionCatalog } from "./session-catalog.ts";
import type {
	SessionPage,
	SessionTarget,
	WorkerEvent,
	WorkerObservation,
	WorkerObservationFrame,
	WorkerObservationSink,
	WorkerPulledValue,
	WorkerRegistration,
	WorkerService,
} from "./worker-contract.ts";

/** First page size for `sessions_changed` refreshes. */
const SESSION_PAGE_SIZE = 10;

export type LocalManagerFactory = (opts: Parameters<typeof createManager>[0]) => Promise<Manager>;

export interface LocalWorkerOptions {
	/** The Project configuration this Worker serves. */
	projects: ProjectConfig[];
	agentDir: string;
	modelRuntime: ModelRuntime;
	managerFactory: LocalManagerFactory;
	/** Idle-collection delays (ADR 11 policy; defaults from the actor). */
	idleGcMs?: number;
	unflushedIdleGcMs?: number;
	/** The thinking level a fresh session on a picked model resolves to before
	 * clamping (the Project-settings read). */
	requestedThinkingLevel: (projectId: string, provider: string, modelId: string) => string;
}

/** The in-process Worker: the contract plus the registry it owns. Callers that
 * route through `WorkerService` never need the extra members. */
export interface LocalWorker extends WorkerService {
	readonly registration: WorkerRegistration;
	/** Live records, for tests and diagnostics. */
	liveRecords(): ActivationRecord[];
}

interface ObservationState {
	id: string;
	record: ActivationRecord;
	sink: WorkerObservationSink;
	capability: SessionCapability | null;
	observation: ObservationCapability | null;
	/** This observation's lazy demand: the paths it pulled while live. Live
	 * patches are filtered against it here, so a Connection never receives
	 * withheld content it did not ask for (and a remote Worker never ships it).
	 * An initial sync clears it: the frame is already the full state. */
	demand: Set<string>;
	released: boolean;
}

export function createLocalWorker(options: LocalWorkerOptions): LocalWorker {
	const projects = new Map(options.projects.map((project) => [project.id, project]));
	const idleGcMs = options.idleGcMs ?? DEFAULT_IDLE_GC_MS;
	const unflushedIdleGcMs = options.unflushedIdleGcMs ?? DEFAULT_UNFLUSHED_IDLE_GC_MS;
	const incarnation = randomUUID();
	const registration: WorkerRegistration = { id: `local-${incarnation}`, incarnation, generation: 1 };

	const observations = new Map<string, ObservationState>();
	const listeners = new Set<(event: WorkerEvent) => void>();
	let disposed = false;

	const emit = (event: WorkerEvent): void => {
		for (const listener of listeners) {
			try {
				listener(event);
			} catch {
				// A throwing listener cannot defeat the worker's own bookkeeping.
			}
		}
	};

	const liveEntries = (): CatalogLiveEntry[] =>
		registry.live().map((record) => ({ ref: record.ref, metadata: record.actor.metadata() }));

	const catalog = createSessionCatalog(projects);

	const emitActiveSessions = (): void => {
		if (disposed) return;
		emit({ kind: "active_sessions_changed", sessions: catalog.listActiveSessions(liveEntries()) });
	};

	const emitSessionsChanged = (projectId: string): void => {
		if (disposed) return;
		try {
			emit({
				kind: "sessions_changed",
				projectId,
				page: catalog.listSessions(projectId, SESSION_PAGE_SIZE, null, liveEntries()),
			});
		} catch {
			// An unknown project or an unreadable directory is not a reason to
			// break the caller's operation: the client re-queries on navigation.
		}
	};

	const registry = new ActivationRegistry({
		incarnation,
		createManager: (project, _stem, abs) =>
			options.managerFactory({
				cwd: project.cwd,
				agentDir: options.agentDir,
				modelRuntime: options.modelRuntime,
				sessionPath: abs,
			}),
		idleGcMs,
		unflushedIdleGcMs,
		onSettled: (ref) => {
			// The first settle after newSession flushes the file — rescan so the
			// session moves to mtime ordering and its metadata appears.
			emitSessionsChanged(ref.projectId);
			emitActiveSessions();
		},
		onStreamingChange: () => emitActiveSessions(),
		onRegistryChange: () => emitActiveSessions(),
		onCollected: (record) => endObservations(record),
	});

	assertNoSessionIdConflicts(projects);

	const requireProject = (projectId: string): ProjectConfig => {
		const project = projects.get(projectId);
		if (!project) throw new Error(`Unknown project: ${projectId}`);
		return project;
	};

	/** One target for one record: the address, the durable identity, the
	 * registration, and the activation generation the record was registered
	 * with. */
	const targetOf = (record: ActivationRecord): SessionTarget => ({
		projectId: record.ref.projectId,
		stem: record.ref.stem,
		sessionId: record.ref.sessionId,
		cwd: record.admission.cwd,
		worker: registration,
		activation: record.authorization.generation,
	});

	/** Resolve a target to the admission of the Activation it names. A target
	 * from a replaced registration, a replaced Activation, or another Session
	 * at the same address is refused: work composed against an identity that
	 * ended must not reach its successor. */
	const admissionFor = (target: SessionTarget): SessionAdmission => {
		if (target.worker.incarnation !== registration.incarnation || target.worker.id !== registration.id) {
			throw new Error("stale session target: replaced registration");
		}
		if (target.worker.generation !== registration.generation) {
			throw new Error("stale session target: replaced registration");
		}
		const record = registry.byAddressAny(target.projectId, target.stem);
		if (!record) throw new Error("session is closed");
		if (record.ref.sessionId !== target.sessionId) throw new Error("stale session target: session changed");
		if (record.authorization.generation !== target.activation) {
			throw new Error("stale session target: replaced activation");
		}
		return record.admission;
	};

	/** Install one observation on a live record: the counted capability that
	 * keeps the Activation alive, plus the handle that forwards the Manager's
	 * stream to the sink. The initial sync is emitted synchronously by
	 * `observe`, so a caller never receives the observation without it. */
	const installObservation = (record: ActivationRecord, sink: WorkerObservationSink, cursor: PrefixCursor | null) => {
		const state: ObservationState = {
			id: randomUUID(),
			record,
			sink,
			capability: null,
			observation: null,
			demand: new Set(),
			released: false,
		};
		const deliver = (frame: WorkerObservationFrame): void => {
			if (state.released) return;
			try {
				state.sink(frame);
			} catch {
				// A throwing sink is a caller bug; it must not corrupt the actor.
			}
		};
		const handle: ConnectionHandle = {
			onPatch: (patch) => {
				// Filter at the observation, not at the socket: demand belongs to the
				// stream that declared it, so two observations of one Session each
				// receive exactly what they pulled.
				const ops = filterPatchForSocket([...patch.ops], state.demand);
				if (ops.length > 0) deliver({ kind: "patch", ops });
			},
			onInitialSync: (frame) => {
				// An initial sync is the observation's full state, so it clears its
				// demand. Both forms are address-bearing: a replace carries its
				// Document, a cursor-validated delta carries the SessionRef its ops
				// apply to.
				state.demand.clear();
				if (frame.kind === "replace")
					deliver({ kind: "replace", session: frame.session, document: frame.document });
				else deliver({ kind: "patch", session: frame.session, ops: frame.ops });
			},
		};
		const capability = record.actor.capability();
		const observation = capability.observe(handle, cursor);
		state.capability = capability;
		state.observation = observation;
		observations.set(state.id, state);

		const release = async (): Promise<void> => {
			if (state.released) return;
			state.released = true;
			observations.delete(state.id);
			await state.observation?.release();
			await state.capability?.release();
		};

		return {
			id: state.id,
			target: targetOf(record),
			pull: async (requests: readonly PullRequestItem[]): Promise<WorkerPulledValue[]> => {
				const values = await capability.pull([...requests]);
				// A live value keeps streaming: register its path as this
				// observation's demand so later patches for it are delivered here.
				for (const value of values) if (value.live) state.demand.add(value.fieldPath);
				return values;
			},
			release,
		} satisfies WorkerObservation;
	};

	/** End every observation of a registration whose indexes are gone: the
	 * terminal frame is delivered (the actor's close already flushed the final
	 * patches), then the handles are released. */
	function endObservations(record: ActivationRecord): void {
		for (const state of [...observations.values()]) {
			if (state.record !== record) continue;
			if (!state.released) {
				state.released = true;
				observations.delete(state.id);
				try {
					state.sink({ kind: "closed", address: { projectId: record.ref.projectId, stem: record.ref.stem } });
				} catch {
					// see deliver
				}
			}
			void state.observation?.release();
			void state.capability?.release();
		}
	}

	return {
		registration,

		observeSession: async (address, sessionOptions) => {
			if (disposed) throw new Error("worker is shutting down");
			const project = requireProject(address.projectId);
			const stem = normalizeStem(address.stem);
			const abs = resolveStemPath(project.sessionDir, stem);
			const record = await registry.open(project, stem, abs);
			const observation = installObservation(record, sessionOptions.sink, sessionOptions.cursor ?? null);
			return { target: observation.target, observation };
		},

		createSession: async (projectId, sessionOptions) => {
			if (disposed) throw new Error("worker is shutting down");
			const project = requireProject(projectId);
			const { text, images, model, thinkingLevel, sink } = sessionOptions;
			// The whole Manager-owning phase — creation, registration, and the
			// pre-attach choices — runs as one registry-tracked creation, so a
			// factory that completes after shutdown began is disposed inside the
			// operation the shutdown drain awaits.
			const record = await registry.runCreation(async () => {
				const manager = await options.managerFactory({
					cwd: project.cwd,
					agentDir: options.agentDir,
					modelRuntime: options.modelRuntime,
				});
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
				// its attachments) before the observation — the initial sync carries
				// the in-flight turn on the chosen model, and no empty session exists
				// while the user types. A refused admission or unknown model disposes
				// the fresh activation.
				try {
					if (model) {
						await manager.setModel(model.provider, model.modelId);
						if (thinkingLevel === undefined) {
							await manager.setThinkingLevel(
								options.requestedThinkingLevel(project.id, model.provider, model.modelId),
							);
						}
					}
					if (thinkingLevel) await manager.setThinkingLevel(thinkingLevel);
					await manager.promptAdmitted(text, images);
				} catch (err) {
					await registry.collect(record);
					throw err;
				}
				return record;
			});
			const observation = installObservation(record, sink, null);
			return { target: observation.target, observation };
		},

		closeSession: async (address) => {
			const project = requireProject(address.projectId);
			const stem = normalizeStem(address.stem);
			const record = await registry.awaitSettled(project.id, stem);
			if (!record || record.actor.phase !== "live" || record.collecting !== null) {
				throw new Error(`Session is not active: ${stem}`);
			}
			await registry.collect(record);
		},

		archiveSession: async (address) => {
			const project = requireProject(address.projectId);
			// Rejects the archive prefix itself, so an archived stem can never be
			// re-addressed.
			const stem = normalizeStem(address.stem);
			const record = await registry.awaitSettled(project.id, stem);
			// Close first, unconditionally: disposal finalizes an in-flight turn,
			// which can create or advance the file, so the move must follow it.
			if (record) await registry.collect(record);
			archiveStemFile(project.sessionDir, stem);
			emitSessionsChanged(project.id);
		},

		// ── Session commands (target-addressed) ─────────────────────────
		prompt: async (target, text, images) => admissionFor(target).prompt(text, images),
		abort: async (target) => admissionFor(target).abort(),
		discardSteer: async (target) => admissionFor(target).discardSteer(),
		setModel: async (target, provider, modelId) => admissionFor(target).setModel(provider, modelId),
		setThinkingLevel: async (target, level) => admissionFor(target).setThinkingLevel(level),
		renameSession: async (target, name) => {
			await admissionFor(target).renameSession(name);
			emitSessionsChanged(target.projectId);
		},
		setLabel: async (target, entryId, label) => admissionFor(target).setLabel(entryId, label),
		navigate: async (target, entryId) => admissionFor(target).navigate(entryId),
		recoverTurn: async (target) => admissionFor(target).recoverTurn(),

		// ── Queries ─────────────────────────────────────────────────────
		listSessions: async (projectId: string, max?: number, cursor?: SessionListCursor | null): Promise<SessionPage> =>
			catalog.listSessions(projectId, max, cursor ?? null, liveEntries()),
		listActiveSessions: async (): Promise<SessionInfo[]> => catalog.listActiveSessions(liveEntries()),

		onEvent: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},

		liveRecords: () => registry.live(),

		dispose: async () => {
			if (disposed) return;
			disposed = true;
			for (const state of [...observations.values()]) {
				state.released = true;
				observations.delete(state.id);
				void state.observation?.release();
				void state.capability?.release();
			}
			listeners.clear();
			await registry.dispose();
		},
	};
}
