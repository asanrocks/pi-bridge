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
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	DEFAULT_THINKING_LEVEL,
	DefaultResourceLoader,
	findInitialModel,
	type ModelRuntime,
	ModelRuntime as ModelRuntimeImpl,
	resolveModelScopeWithDiagnostics,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	filterPatchForSocket,
	type ModelInfo,
	type ModelRef,
	type PinnedModelInfo,
	type PinnedModelSelection,
	type PrefixCursor,
	type ProjectInfo,
	type PullRequestItem,
	type SessionInfo,
	type SessionListCursor,
	THINKING_LEVEL_NAMES,
} from "../core/index.ts";
import { type ActivationRecord, ActivationRegistry } from "./activation-registry.ts";
import { createLifecycleScope } from "./lifecycle-scope.ts";
import type { ConnectionHandle, createManager, Manager } from "./manager.ts";
import { resolveVisibleModelKeys } from "./model-visibility.ts";
import { setWorkerTitle } from "./process-title.ts";
import {
	archiveStemFile,
	containedSessionFile,
	normalizeStem,
	type ProjectConfig,
	resolveStemPath,
	stemFromSessionPath,
} from "./projects.ts";
import { listDirectory, listFiles, readFileAtSnapshot, resolveGitBase, runGitDiff, runGitShow } from "./repository.ts";
import {
	DEFAULT_IDLE_GC_MS,
	DEFAULT_UNFLUSHED_IDLE_GC_MS,
	type ObservationCapability,
	type SessionAdmission,
	type SessionCapability,
} from "./session-actor.ts";
import { assertNoSessionIdConflicts, type CatalogLiveEntry, createSessionCatalog } from "./session-catalog.ts";
import { createSessionStates, type SessionStates, type SessionToggleState } from "./session-state.ts";
import { readBridgeSettings } from "./settings.ts";
import { acquireStorageLock, type StorageLock } from "./storage-lock.ts";
import type {
	SessionAddress,
	SessionPage,
	SessionTarget,
	WorkerEvent,
	WorkerInfo,
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
	/** Per-Project settings, created from `agentDir` when absent (test seam). */
	projectSettings?: Map<string, SettingsManager>;
	/** The daemon-global settings (the `enabledModels` scope), created from
	 * `agentDir` when absent (test seam). */
	globalSettings?: SettingsManager | null;
	/** The thinking level a fresh session on a picked model resolves to before
	 * clamping. Defaults to the Project-settings chain this Worker owns. */
	requestedThinkingLevel?: (projectId: string, provider: string, modelId: string) => string;
	/** Session-directory exclusion claims this Worker holds (see
	 * `storage-lock.ts`). Released when the Worker disposes; a Worker built
	 * without them serves unsynchronized and is only safe in tests. */
	storageLocks?: StorageLock[];
}

/** The in-process Worker: the contract plus the registry it owns. Callers that
 * route through `WorkerService` never need the extra members. */
export interface LocalWorker extends WorkerService {
	readonly registration: WorkerRegistration;
	/** Live records, for tests and diagnostics. */
	liveRecords(): ActivationRecord[];
	/** The Projects this Worker serves (the Daemon routes by id). */
	projects(): ProjectConfig[];
	/** Report the Daemon link's state to the process title: a dialed-out Worker
	 * that lost its Daemon is neither idle nor busy, and the title says so. */
	setLink(state: "up" | "down"): void;
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
	/** The Daemon link, as the dialed-out deployment sees it (always `up` for an
	 * in-process or socket-served Worker: those have no link of their own). */
	let link: "up" | "down" = "up";
	/** The memoized disposal drain: a second `dispose()` joins the first
	 * caller's drain instead of returning as if disposal had finished. The
	 * Worker process's socket shutdown and its signal handler both dispose —
	 * without the join, whichever ran second could proceed (and exit) before
	 * the runtime drain and the storage-claim releases completed. */
	let disposeDrain: Promise<void> | null = null;

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
	// The durable, user-visible session lifecycle: Worker-owned
	// storage beside the sessions it describes, loaded and recovered once at
	// construction — a persisted busy is rewritten to notified here, because
	// this process died with the runtimes that were executing.
	const states: SessionStates = createSessionStates(projects);

	// ── Environment: settings, catalogue, repository ───────────────────
	//
	// These belong to the Worker, not the Daemon: a remote Worker's filesystem
	// and model catalogue are not reachable from the Daemon, so the Daemon serves
	// the Worker's report verbatim (commit 8 of the Worker split).
	const projectSettings = options.projectSettings ?? new Map<string, SettingsManager>();
	if (options.projectSettings === undefined) {
		for (const project of projects.values()) {
			try {
				projectSettings.set(project.id, SettingsManager.create(project.cwd, options.agentDir));
			} catch {
				// Unreadable settings degrade to the model-runtime defaults.
			}
		}
	}
	let globalSettings: SettingsManager | null = options.globalSettings ?? null;
	if (options.globalSettings === undefined) {
		try {
			globalSettings = SettingsManager.create(process.cwd(), options.agentDir);
		} catch {
			globalSettings = null;
		}
	}
	/** One mutation at a time, in arrival order: `setPinnedModels` rewrites the
	 * global scope, so concurrent writes would drop one another. */
	const settingsMutations = createLifecycleScope();

	const requestedThinkingLevelOf = (projectId: string, provider: string, modelId: string): string => {
		const injected = options.requestedThinkingLevel?.(projectId, provider, modelId);
		if (injected !== undefined) return injected;
		const settings = projectSettings.get(projectId);
		return (
			settings?.getModelThinkingLevel(provider, modelId) ??
			settings?.getDefaultThinkingLevel() ??
			DEFAULT_THINKING_LEVEL
		);
	};

	/** Resolve pi's global `enabledModels` scope into the pinned list (ADR 15).
	 * Project-level overrides are intentionally ignored: pinned models is one
	 * daemon-global concept. */
	const resolvePinnedModels = async (): Promise<PinnedModelInfo[]> => {
		const patterns = globalSettings?.getGlobalSettings().enabledModels;
		if (!patterns || patterns.length === 0) return [];
		const { scopedModels: resolved } = await resolveModelScopeWithDiagnostics(patterns, options.modelRuntime);
		return resolved.map((sm) => ({
			provider: sm.model.provider,
			id: sm.model.id,
			name: sm.model.name ?? sm.model.id,
			thinkingLevel: sm.thinkingLevel,
		}));
	};

	/** The model and thinking level a fresh session in a Project resolves to —
	 * the same `findInitialModel` call a fresh Manager's session performs. */
	const projectDefaults = async (
		projectId: string,
	): Promise<{ model: ModelRef | null; thinkingLevel: string | null }> => {
		const settings = projectSettings.get(projectId);
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			...(settings
				? {
						defaultProvider: settings.getDefaultProvider(),
						defaultModelId: settings.getDefaultModel(),
						defaultThinkingLevel: settings.getDefaultThinkingLevel(),
						modelThinkingLevels: settings.getAllModelThinkingLevels(),
					}
				: {}),
			modelRuntime: options.modelRuntime,
		});
		return {
			model: result.model ? { provider: result.model.provider, modelId: result.model.id } : null,
			thinkingLevel: result.model ? result.thinkingLevel : null,
		};
	};

	/** The work-queue snapshot: membership is the durable state, so
	 * browsing a session never reaches this list and idle collection never
	 * removes a row from it. */
	const emitQueue = (): void => {
		if (disposed) return;
		emit({ kind: "queue_changed", sessions: catalog.listQueue(liveEntries(), states) });
	};

	const emitSessionsChanged = (projectId: string): void => {
		if (disposed) return;
		try {
			emit({
				kind: "sessions_changed",
				projectId,
				page: catalog.listSessions(projectId, SESSION_PAGE_SIZE, null, liveEntries(), states),
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
			emitQueue();
			refreshTitle();
		},
		onFullySettled: (ref, execution) => {
			// Full settlement of an admitted execution: busy becomes
			// notified when the token is still current — the settle of an
			// execution a newer admission superseded changes nothing.
			if (typeof execution === "string") states.settle(ref.projectId, ref.stem, execution);
			emitQueue();
		},
		onStreamingChange: () => {
			emitQueue();
			refreshTitle();
		},
		onRegistryChange: () => {
			emitQueue();
			refreshTitle();
		},
		onActivityChange: () => {
			// The runtime changed phase (a tool started, text began streaming):
			// the queue's activity line moved. The Manager dedupes these to phase
			// transitions, so this cannot fire per token.
			emitQueue();
			refreshTitle();
		},
		onCollected: (record) => endObservations(record),
	});

	/**
	 * Publish this Worker's half of the process title.
	 *
	 * The phase is read from the live Sessions at publish time rather than
	 * tracked here: one Worker serves many Sessions and the interesting one is
	 * "whichever is furthest along", a decision that belongs to the formatter.
	 */
	function refreshTitle(): void {
		if (disposed) return;
		setWorkerTitle({
			projects: [...projects.keys()],
			sessions: registry.live().map((record) => record.actor.activity()),
			link,
		});
	}

	refreshTitle();

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

	/** A session exists at this stem: a live activation (any phase — the
	 * caller may need to wait out a collection), else a contained durable
	 * file. False when neither exists — the stem names no session this
	 * Worker serves. */
	const sessionExistsAt = async (project: ProjectConfig, stem: string): Promise<boolean> => {
		const record = await registry.awaitSettled(project.id, stem);
		if (record) return true;
		return containedSessionFile(project.sessionDir, resolveStemPath(project.sessionDir, stem)) !== null;
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
								requestedThinkingLevelOf(project.id, model.provider, model.modelId),
							);
						}
					}
					if (thinkingLevel) await manager.setThinkingLevel(thinkingLevel);
					// The first prompt is an execution like any other:
					// admitted under a store token, so its full settlement lands
					// notified and a refused preflight restores the empty state.
					const execution = states.admit(project.id, record.ref.stem);
					try {
						await manager.promptAdmitted(text, images, undefined, undefined, execution);
					} catch (err) {
						states.abandon(project.id, record.ref.stem, execution);
						throw err;
					}
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
			if (record && record.actor.phase !== "live") {
				// A collecting activation is mid-disposal: today's window where
				// the close is refused rather than joined.
				throw new Error(`Session is not active: ${stem}`);
			}
			if (record && record.collecting === null) {
				// Live runtime: the close captures the current execution token,
				// then collects — disposal aborts and finalizes the in-flight
				// turn, whose settle lands notified first — and finally writes
				// inactive, so the close is the last write for that execution.
				// An admission that began after the capture is a newer user
				// intent: the write is skipped, the session stays busy.
				const since = states.tokenOf(project.id, record.ref.stem);
				await registry.collect(record);
				states.markInactive(project.id, record.ref.stem, since);
				emitQueue();
				return;
			}
			// Dormant close: legal without a runtime — the state write
			// is the whole operation, and the stem is the record's key. The token is
			// captured before the existence probe's await: an admission landing in
			// between is a newer intent, and the write must then be skipped rather
			// than consume that execution's token as its own precondition.
			const since = states.tokenOf(project.id, stem);
			if (!(await sessionExistsAt(project, stem))) throw new Error(`No such session: ${stem}`);
			states.markInactive(project.id, stem, since);
			emitQueue();
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
			// The archived session leaves discovery and the queue together: the
			// move takes the file out of the Project's namespace and the prune
			// drops the state record keyed by the stem it was addressed at.
			archiveStemFile(project.sessionDir, stem);
			states.prune(project.id, stem);
			emitSessionsChanged(project.id);
			emitQueue();
		},

		// ── Session commands (target-addressed) ─────────────────────────
		prompt: async (target, text, images, model, thinkingLevel) => {
			const admission = admissionFor(target);
			// Admission is an execution: the store lands busy under a
			// fresh token before the turn starts, so any transition racing the
			// admission — a defer from another tab — evaluates against busy,
			// and a refused preflight restores the pre-admission state.
			const execution = states.admit(target.projectId, target.stem);
			emitQueue();
			try {
				await admission.prompt(text, images, model, thinkingLevel, execution);
			} catch (err) {
				states.abandon(target.projectId, target.stem, execution);
				emitQueue();
				throw err;
			}
		},
		abort: async (target) => admissionFor(target).abort(),
		discardSteer: async (target) => admissionFor(target).discardSteer(),
		renameSession: async (target, name) => {
			await admissionFor(target).renameSession(name);
			emitSessionsChanged(target.projectId);
		},
		setLabel: async (target, entryId, label) => admissionFor(target).setLabel(entryId, label),
		navigate: async (target, entryId) => admissionFor(target).navigate(entryId),
		recoverTurn: async (target) => {
			const admission = admissionFor(target);
			// Recovery is an execution on both of its paths: the relay
			// prompt and the silent continuation report admission and completion
			// through the same seams as any other turn.
			const execution = states.admit(target.projectId, target.stem);
			emitQueue();
			try {
				return await admission.recoverTurn(execution);
			} catch (err) {
				states.abandon(target.projectId, target.stem, execution);
				emitQueue();
				throw err;
			}
		},

		// ── Queries ─────────────────────────────────────────────────────
		listSessions: async (projectId: string, max?: number, cursor?: SessionListCursor | null): Promise<SessionPage> =>
			catalog.listSessions(projectId, max, cursor ?? null, liveEntries(), states),
		listQueue: async (): Promise<SessionInfo[]> => catalog.listQueue(liveEntries(), states),

		setSessionState: async (address: SessionAddress, state: SessionToggleState): Promise<void> => {
			const project = requireProject(address.projectId);
			const stem = normalizeStem(address.stem);
			if (!(await sessionExistsAt(project, stem))) throw new Error(`No such session: ${stem}`);
			// The store owns the precondition: a defer racing an admission is
			// refused here, not by a caller that may have raced it.
			states.toggle(project.id, stem, state);
			emitQueue();
		},

		// ── Environment (Worker-owned reads and settings) ───────────────
		info: async (): Promise<WorkerInfo> => {
			const models: ModelInfo[] = options.modelRuntime.getAvailableSnapshot().map((m) => ({
				provider: m.provider,
				providerName: options.modelRuntime.getProvider(m.provider)?.name,
				id: m.id,
				name: m.name ?? m.id,
				reasoning: m.reasoning ?? false,
				supportedThinkingLevels: getSupportedThinkingLevels(m),
				contextWindow: m.contextWindow,
			}));
			const visiblePatterns = readBridgeSettings(options.agentDir).visibleModels ?? [];
			const visibleModels = visiblePatterns.length > 0 ? resolveVisibleModelKeys(visiblePatterns, models) : [];
			const projectInfos: ProjectInfo[] = await Promise.all(
				[...projects.values()].map(async (p) => {
					const defaults = await projectDefaults(p.id);
					return {
						id: p.id,
						cwd: p.cwd,
						defaultModel: defaults.model,
						defaultThinkingLevel: defaults.thinkingLevel,
					};
				}),
			);
			return {
				projects: projectInfos,
				models,
				pinnedModels: await resolvePinnedModels(),
				visibleModels,
				thinkingLevels: [...THINKING_LEVEL_NAMES],
			};
		},

		setPinnedModels: (models: PinnedModelSelection[]) =>
			settingsMutations.run(async (): Promise<void> => {
				const settings = globalSettings;
				if (!settings) throw new Error("No global settings available");
				// A replacement is a proposal: the client cannot know the catalogue,
				// so an entry the runtime cannot resolve is dropped rather than
				// written, and the push reports the result. Position is meaning, so
				// the first occurrence of an identity wins and nothing is re-sorted.
				// The level suffix rides through verbatim, which is what keeps a
				// reorder from silently changing what a pin means.
				const seen = new Set<string>();
				const patterns: string[] = [];
				for (const entry of models) {
					const key = `${entry.provider}/${entry.id}`;
					const lower = key.toLowerCase();
					if (seen.has(lower)) continue;
					if (!options.modelRuntime.getModel(entry.provider, entry.id)) continue;
					seen.add(lower);
					const level =
						entry.thinkingLevel !== undefined && THINKING_LEVEL_NAMES.includes(entry.thinkingLevel)
							? entry.thinkingLevel
							: undefined;
					patterns.push(level === undefined ? key : `${key}:${level}`);
				}
				settings.setEnabledModels(patterns.length > 0 ? patterns : undefined);
				await settings.flush();
				if (disposed) return;
				emit({ kind: "pinned_models_changed", pinnedModels: await resolvePinnedModels() });
			}),

		listFiles: async (prefix: string, projectId: string) => listFiles(prefix, requireProject(projectId).cwd),
		readFile: async (path: string, state?: string) => readFileAtSnapshot(path, state ?? "worktree"),
		listDirectory: async (path: string, state?: string) => listDirectory(path, state ?? "worktree"),
		gitShow: async (commit: string, cwd: string) => runGitShow(commit, cwd),
		gitBase: async (directory: string, commit: string) => resolveGitBase(directory, commit),
		gitDiff: async (directory: string, oldState: string, newState: string) =>
			runGitDiff(oldState, newState, directory),

		onEvent: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},

		liveRecords: () => registry.live(),

		projects: () => [...projects.values()],

		setLink: (state) => {
			if (state === link) return;
			link = state;
			refreshTitle();
		},

		dispose: (): Promise<void> => {
			if (disposeDrain !== null) return disposeDrain;
			disposed = true;
			setWorkerTitle(null);
			disposeDrain = (async () => {
				for (const state of [...observations.values()]) {
					state.released = true;
					observations.delete(state.id);
					void state.observation?.release();
					void state.capability?.release();
				}
				listeners.clear();
				await registry.dispose();
				await settingsMutations.close();
				// Exclusion is released last: every runtime is gone before the
				// directory can be served by a successor.
				for (const lock of options.storageLocks ?? []) await lock.release().catch(() => {});
			})();
			return disposeDrain;
		},
	};
}

/**
 * pi-core runs offline in the bridge: the Worker owns no background network
 * work. pi reads these variables at call time (tool binary downloads, catalog
 * and package refreshes), so they must be set before the ModelRuntime or any
 * extension exists.
 *
 * This lives with the Worker, not the Daemon: a standalone `--worker-serve`
 * process creates the runtimes, so it must establish the mode itself. Setting
 * it in only one entry point would leave the other silently online.
 */
export function enterOfflineMode(): void {
	process.env.PI_OFFLINE = "1";
	process.env.PI_SKIP_VERSION_CHECK = "1";
}

/** Build a Worker with the environment it owns: the model runtime (created
 * when the caller did not inject one), the extension-registered providers, and
 * the Session-directory exclusion claims.
 *
 * This is the entry the Worker process and the in-process Daemon both use, so
 * neither of them has to know how pi's runtime or its extensions are set up.
 * A caller that already holds a runtime (tests, an embedding host) keeps
 * passing it and skips creation.
 *
 * Exclusion is acquired here, before any Manager can exist: a directory already
 * served by a live owner fails the start rather than being written
 * unsynchronized. */
export async function startLocalWorker(
	options: Omit<LocalWorkerOptions, "modelRuntime" | "storageLocks"> & {
		modelRuntime?: ModelRuntime;
		/** Skip exclusion (tests that build throwaway fixtures). */
		skipStorageLock?: boolean;
	},
): Promise<LocalWorker> {
	// Offline before anything can reach the network (see `enterOfflineMode`).
	enterOfflineMode();
	const modelRuntime =
		options.modelRuntime ?? (await ModelRuntimeImpl.create({ authPath: join(options.agentDir, "auth.json") }));
	await loadExtensionProviders(modelRuntime, options.agentDir);

	const storageLocks: StorageLock[] = [];
	if (options.skipStorageLock !== true) {
		try {
			// One claim per distinct Session directory: two Projects may not share
			// storage (validated below), but the dedupe keeps the claim count honest.
			const directories = new Set(options.projects.map((project) => project.sessionDir));
			for (const directory of directories) storageLocks.push(await acquireStorageLock(directory));
		} catch (error) {
			for (const lock of storageLocks) await lock.release().catch(() => {});
			throw error;
		}
	}
	try {
		return createLocalWorker({ ...options, modelRuntime, storageLocks });
	} catch (error) {
		for (const lock of storageLocks) await lock.release().catch(() => {});
		throw error;
	}
}

/** Register the providers disk extensions add, so `info()` reports them before
 * any Session exists. A broken extension degrades to the plain catalogue
 * instead of failing startup. */
async function loadExtensionProviders(modelRuntime: ModelRuntime, agentDir: string): Promise<void> {
	try {
		const cwd = process.cwd();
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		const extensionsResult = resourceLoader.getExtensions();
		for (const { name, config } of extensionsResult.runtime.pendingProviderRegistrations) {
			modelRuntime.registerProvider(name, config);
		}
		for (const { provider } of extensionsResult.runtime.pendingNativeProviderRegistrations) {
			modelRuntime.registerNativeProvider(provider);
		}
		modelRuntime.setProxyResolvers(extensionsResult.runtime.proxyResolvers);
	} catch (error) {
		console.error(`Worker: extension load failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
