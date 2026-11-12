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
import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	DEFAULT_THINKING_LEVEL,
	DefaultResourceLoader,
	findInitialModel,
	type ModelRuntime,
	ModelRuntime as ModelRuntimeImpl,
	resolveModelScopeWithDiagnostics,
	type SessionEntry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	AGENT_MESSAGE_CUSTOM_TYPE,
	compareQueueRows,
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
	type SessionLocation,
	type SessionOutcome,
	type SessionRef,
	THINKING_LEVEL_NAMES,
} from "../core/index.ts";
import { type ActivationRecord, ActivationRegistry } from "./activation-registry.ts";
import {
	type AgentAddress,
	type AgentControlService,
	type AgentResumeContext,
	type AgentSpawnContext,
	type AgentStatus,
	type ControlledAgent,
	createAgentControl,
	interAgentBody,
	MAX_CONCURRENT_TURNS,
	ROOT_PATH,
	type SpawnAgentRequest,
	settledStatus,
} from "./agent-control.ts";
import { POLICY_CUSTOM_TYPE, subAgentPolicy } from "./agent-policy.ts";
import { createLifecycleScope } from "./lifecycle-scope.ts";
import type { ConnectionHandle, createManager, Manager } from "./manager.ts";
import { resolveVisibleModelKeys } from "./model-visibility.ts";
import { setWorkerTitle } from "./process-title.ts";
import {
	containedSessionFile,
	migrateLegacyTrashDir,
	normalizeStem,
	type ProjectConfig,
	reserveSessionFile,
	resolveStemPath,
	stemFromSessionPath,
	subtreeStemsUnder,
	trashStemFile,
} from "./projects.ts";
import { listDirectory, listFiles, readFileAtSnapshot, resolveGitBase, runGitDiff, runGitShow } from "./repository.ts";
import {
	DEFAULT_IDLE_GC_MS,
	DEFAULT_UNFLUSHED_IDLE_GC_MS,
	type ObservationCapability,
	type SessionAdmission,
	type SessionCapability,
} from "./session-actor.ts";
import {
	assertNoSessionIdConflicts,
	type CatalogLiveEntry,
	createSessionCatalog,
	scanDurableSessionIds,
} from "./session-catalog.ts";
import { createSessionLocations, type SessionLocations } from "./session-locations.ts";
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

/** The queue slice's address key, and the identity a completion suppression is
 * recorded under. */
function addressKey(projectId: string, stem: string): string {
	return `${projectId}\0${stem}`;
}

/** The last assistant text a branch produced, stopping at the entry a full fork
 * copied last: inherited parent messages are the parent's answer, not this
 * agent's, and Codex reports the turn's text rather than the transcript's.
 * Exported for its unit test; the Worker is the only caller. */
export function lastAssistantTextBefore(
	entries: readonly SessionEntry[],
	boundaryId: string | undefined,
): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry === undefined) continue;
		if (entry.id === boundaryId) return undefined;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const text = entry.message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		if (text !== "") return text;
	}
	return undefined;
}

export type LocalManagerFactory = (opts: Parameters<typeof createManager>[0]) => Promise<Manager>;

/** The file stem a canonical task path names, read from any Session in the same
 * tree: a child is stored at `<spawner stem>/<task name>`, so the tree hangs off
 * the root's stem and everything below `/root` is a directory below it. Exported
 * for its unit test; the Worker is the only caller.
 *
 * The one place the path/stem mapping exists. The control plane asks the Worker
 * for an address instead of deriving one, so a layout change stops here. */
export function stemForAgentPath(sessionStem: string, sessionPath: string, path: string): string {
	const suffix = sessionPath.slice(ROOT_PATH.length);
	const rootStem = suffix === "" ? sessionStem : sessionStem.slice(0, -suffix.length);
	return `${rootStem}${path.slice(ROOT_PATH.length)}`;
}

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

	// A pre-rename `.archive/` namespace becomes `.trash/` before anything reads
	// storage: "archive" now names a location, and the directory that held
	// files moved away is what "trash" means.
	for (const project of projects.values()) migrateLegacyTrashDir(project.sessionDir, console.error);
	const catalog = createSessionCatalog(projects);
	// The durable, user-visible placements: Worker-owned storage beside the
	// sessions they describe, loaded once at construction. Running is a runtime
	// attribute and has no stored form, so a restart has nothing to recover.
	const locations: SessionLocations = createSessionLocations(projects);

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

	/** This Worker's materialized queue slice, keyed by address. It is the base
	 * every delta is diffed against and the snapshot `listQueue` reports, so a
	 * Daemon never seeds from a query that raced a delta (ADR 24). */
	let publishedQueue = new Map<string, SessionInfo>();
	/** Registration-local version: bumped once per emitted queue delta. */
	let queueVersion = 0;

	/** Rows a metadata-only refresh may reuse: a dormant row's file cannot have
	 * changed except through a trigger that asks for a full rebuild. */
	const reusedQueueRows = (): Map<string, SessionInfo> => publishedQueue;

	/**
	 * Refresh the queue slice and publish the difference.
	 *
	 * `live` rebuilds live rows from registry metadata and reuses dormant rows,
	 * so streaming, activity, and settle triggers read no Session files. `full`
	 * re-reads dormant rows; only registration, placement, Trash, close, and
	 * rename triggers need it. `origin` is the publication urgency the Daemon
	 * applies: `user` for a gesture a person made (its row must move on screen
	 * now), `runtime` for execution state.
	 */
	const refreshQueue = (mode: "live" | "full", origin: "user" | "runtime"): void => {
		if (disposed) return;
		const rows = catalog.listQueue(liveEntries(), locations, mode === "live" ? reusedQueueRows() : undefined);
		const next = new Map<string, SessionInfo>();
		const upsert: SessionInfo[] = [];
		for (const row of rows) {
			const key = addressKey(row.projectId, row.stem);
			next.set(key, row);
			const previous = publishedQueue.get(key);
			// Repeated callbacks observing one transition produce identical rows:
			// nothing to publish, which is what removes the duplicate traffic.
			if (previous === undefined || JSON.stringify(previous) !== JSON.stringify(row)) upsert.push(row);
		}
		const remove = [...publishedQueue.values()]
			.filter((row) => !next.has(addressKey(row.projectId, row.stem)))
			.map((row) => ({ projectId: row.projectId, stem: row.stem }));
		publishedQueue = next;
		if (upsert.length > 0 || remove.length > 0) {
			emit({ kind: "queue_changed", version: ++queueVersion, origin, upsert, remove });
		}
	};

	/** A Project's cached history may be stale. A notice, never a page: the
	 * receiver decides whether it holds that history at all. */
	const emitHistoryChanged = (projectId: string): void => {
		if (disposed) return;
		emit({ kind: "history_changed", projectId });
	};

	/** One execution ended, with how it ended. Membership is not consulted and
	 * nothing is withheld: whether a stop or a failure deserves a notification is
	 * the client's decision, so the report is the fact only (ADR 24). */
	const emitSettled = (ref: SessionRef, outcome: SessionOutcome): void => {
		if (disposed) return;
		const row = publishedQueue.get(addressKey(ref.projectId, ref.stem));
		emit({
			kind: "session_settled",
			session: ref,
			outcome,
			...(row?.name !== undefined ? { name: row.name } : {}),
		});
	};

	/** Every live runtime, for agent control's context fragments. The link is by
	 * `liveSessionId` rather than by record: a Session's id is minted by its file,
	 * so it can differ from the one a record captured at registration, and the
	 * spawner's id is whatever the runtime reports when a child is created. */
	const liveManagers = new Set<Manager>();
	const managerFor = (sessionId: string): Manager | undefined => {
		for (const manager of liveManagers) if (manager.liveSessionId === sessionId) return manager;
		return undefined;
	};

	/** The last execution outcome each Session reported, by session id. The root
	 * has no agent record, so this is the only truthful source for its
	 * `list_agents` status; a transcript read cannot tell interrupted from done. */
	const lastOutcomes = new Map<string, SessionOutcome>();

	/** The collaboration brief each Session was given, by session id, and the
	 * runtimes already watching for compaction. A brief is a context fragment, so
	 * a summary can replace the history it lived in; re-sending it after the
	 * compaction keeps Codex's role instructions in front of the model. */
	const policyBriefings = new Map<string, string>();
	const watchedManagers = new WeakSet<Manager>();

	/** Keep a Session's brief across compaction. One subscription per runtime: a
	 * resumed Session gets a new Manager, and the briefing map outlives it. */
	const rearmPolicy = (manager: Manager, content: string): void => {
		policyBriefings.set(manager.liveSessionId, content);
		if (watchedManagers.has(manager)) return;
		watchedManagers.add(manager);
		manager.onCompacted(() => {
			const briefing = policyBriefings.get(manager.liveSessionId);
			if (briefing === undefined) return;
			void manager.sendContextMessage(POLICY_CUSTOM_TYPE, briefing).catch(() => {});
		});
	};

	const registry = new ActivationRegistry({
		incarnation,
		createManager: async (project, stem, abs) => {
			let manager: Manager | undefined;
			const created = await options.managerFactory({
				cwd: project.cwd,
				agentDir: options.agentDir,
				modelRuntime: options.modelRuntime,
				sessionPath: abs,
				agentControl: {
					service: control,
					parent: () => {
						if (manager === undefined) throw new Error("Session is not registered yet");
						return { projectId: project.id, stem, sessionId: manager.liveSessionId };
					},
				},
			});
			manager = created;
			liveManagers.add(created);
			const briefing = policyBriefings.get(created.liveSessionId);
			if (briefing !== undefined) rearmPolicy(created, briefing);
			return created;
		},
		idleGcMs,
		unflushedIdleGcMs,
		onSettled: (ref, settlement) => {
			// The runtime's metadata advanced (a flush): the live row is rebuilt
			// from memory, the Project's cached history is now stale, and the
			// execution's own end is reported. pi emits a turn boundary after every
			// assistant step, so only the execution boundary is a settle — otherwise
			// a tool-using turn would report itself once per tool batch (ADR 24).
			refreshQueue("live", "runtime");
			emitHistoryChanged(ref.projectId);
			if (settlement.boundary === "execution") {
				lastOutcomes.set(ref.sessionId, settlement.outcome);
				emitSettled(ref, settlement.outcome);
			}
			refreshTitle();
		},
		onStreamingChange: () => {
			refreshQueue("live", "runtime");
			refreshTitle();
		},
		onRegistryChange: () => {
			// Registration and collection move the address between live and
			// dormant, which changes what a row can be read from.
			refreshQueue("full", "runtime");
			refreshTitle();
		},
		onActivityChange: () => {
			// The runtime changed phase (a tool started, text began streaming):
			// the queue's activity line moved. The Manager dedupes these to phase
			// transitions, so this cannot fire per token.
			refreshQueue("live", "runtime");
			refreshTitle();
		},
		onCollected: (record) => {
			// The registration's id is the durable one by the time it is collected,
			// so it is the key that still matches the runtime.
			for (const manager of liveManagers) {
				if (manager.liveSessionId === record.ref.sessionId) liveManagers.delete(manager);
			}
			endObservations(record);
		},
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

	// Seed the materialized slice before anything can observe it: `listQueue`
	// reports it as the baseline and the first delta is a difference from it.
	// Nothing is emitted here — a registration's seed is the query, not a push.
	publishedQueue = new Map(
		catalog.listQueue(liveEntries(), locations).map((row) => [addressKey(row.projectId, row.stem), row] as const),
	);

	assertNoSessionIdConflicts(projects);

	const requireProject = (projectId: string): ProjectConfig => {
		const project = projects.get(projectId);
		if (!project) throw new Error(`Unknown project: ${projectId}`);
		return project;
	};

	// ── Agent control (Codex-style multi-agent tools) ────────────────────
	//
	// The tools are one presentation of a normal Session. Spawning reuses the
	// same creation path as `createSession` (fresh Manager, address derivation,
	// registration, then a first admitted prompt), and holds a capability on the
	// child so idle collection cannot reap an agent the parent still controls.
	// Closing releases that capability and collects the runtime; the file stays
	// and the Session is openable like any other.

	/** The last assistant text a Session produced *itself*, used for a completion
	 * event. Read from the durable branch rather than tracked live: a settled child
	 * may have been compacted, and its file is the result the user would see. */
	const lastAssistantText = (manager: Manager, boundaryId?: string): string | undefined => {
		try {
			return lastAssistantTextBefore(SessionManager.open(manager.sessionFile).getBranch(), boundaryId);
		} catch {
			// An unflushed or unreadable file has no result to report.
			return undefined;
		}
	};

	const splitModelRef = (value: string): { provider: string; modelId: string } => {
		const slash = value.indexOf("/");
		if (slash <= 0 || slash === value.length - 1) {
			throw new Error(`model must be provider/modelId, got ${JSON.stringify(value)}`);
		}
		return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
	};

	/** Claim a child's address before anything is created. The exclusive create is
	 * the reservation, so two concurrent spawns cannot both take one task name and
	 * a name already on disk — a closed child's file, or a crashed spawn's — is
	 * refused instead of being overwritten. */
	const claimChildAddress = (project: ProjectConfig, stem: string, path: string): string => {
		try {
			return reserveSessionFile(project.sessionDir, stem);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				throw new Error(`agent path \`${path}\` is already in use`);
			}
			throw error;
		}
	};

	/** One controlled Session's operations over an activation. Spawn and resume
	 * both end here, so a reloaded child answers exactly like a spawned one: the
	 * capability pins the runtime, settlements are observed once, and every
	 * operation goes through the registration's admission rather than through a
	 * Manager the caller may not own. */
	const bindControlledAgent = (
		record: ActivationRecord,
		identity: {
			readonly parentId: string;
			readonly rootId: string;
			readonly depth: number;
			readonly path: string;
			readonly ancestry: readonly string[];
		},
		options: { readonly model?: string; readonly boundary?: string } = {},
	): ControlledAgent => {
		const capability = record.actor.capability();
		const listeners = new Set<(outcome: SessionOutcome) => void>();
		let lastOutcome: SessionOutcome | undefined;
		let unsubscribe: (() => void) | undefined;
		let closed = false;
		// The admission runs its operation synchronously, so the settlement
		// subscription is in place before this returns even though the promise
		// settles later.
		void record.admission
			.command((session) =>
				Promise.resolve(
					session.onSettled((settlement) => {
						if (settlement.boundary !== "execution") return;
						lastOutcome = settlement.outcome;
						for (const listener of [...listeners]) listener(settlement.outcome);
					}),
				),
			)
			.then((off) => {
				if (closed) off();
				else unsubscribe = off;
			})
			.catch(() => {});
		return {
			id: record.ref.sessionId,
			ref: record.ref,
			parentId: identity.parentId,
			rootId: identity.rootId,
			depth: identity.depth,
			path: identity.path,
			ancestry: [...identity.ancestry],
			...(options.model === undefined ? {} : { model: options.model }),
			isBusy: () => record.actor.activity().phase !== "idle",
			prompt: (message) => record.admission.prompt(message),
			// Codex's `TriggerTurn` for agent mail: the same envelope `send_message`
			// queues, but the recipient starts work if it is idle. It lands as an agent
			// message, so the transcript never claims the human wrote it.
			startTask: (content, details) =>
				record.admission.command((session) =>
					session.startWithContextMessage(AGENT_MESSAGE_CUSTOM_TYPE, content, { display: true, details }),
				),
			interrupt: () => record.admission.abort(),
			close: async () => {
				if (closed) return;
				closed = true;
				unsubscribe?.();
				await capability.release();
				await registry.collect(record);
			},
			lastMessage: () =>
				record.admission.command((session) => Promise.resolve(lastAssistantText(session, options.boundary))),
			onSettled: (listener) => {
				if (lastOutcome !== undefined) {
					listener(lastOutcome);
					return () => {};
				}
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		};
	};

	/** Create one controlled Session. The whole Manager-owning phase is tracked
	 * as a registry creation, so shutdown drains any factory still running. */
	async function spawnControlledAgent(
		context: AgentSpawnContext,
		request: SpawnAgentRequest,
	): Promise<ControlledAgent> {
		if (disposed) throw new Error("worker is shutting down");
		const project = requireProject(context.parent.projectId);
		const parentSessionPath = resolveStemPath(project.sessionDir, context.parent.stem);
		// A spawned Session's address *is* its file name: the child is stored at
		// `<spawner stem>/<task name>`, so the path a parent addresses and the file the
		// daemon scans are one string. Nothing records the relation, and the sidebar's
		// nesting is a projection of the rows themselves.
		const childPath = claimChildAddress(
			project,
			stemForAgentPath(context.parent.stem, context.parentPath, context.path),
			context.path,
		);
		const childDir = dirname(childPath);
		// `all` inherits everything the parent has. A Session that has not been
		// flushed yet has appended no message (`SessionManager` only creates the
		// file with a user or assistant turn), so there is nothing to inherit and
		// `all` is `none` — the failure Codex cannot produce, avoided.
		const forkParent = request.forkTurns === "all" && existsSync(parentSessionPath);
		return registry.runCreation(async () => {
			let ref: SessionRef | undefined;
			let record: ActivationRecord | undefined;
			let agent: ControlledAgent | undefined;
			const agentControl = {
				service: control,
				parent: (): SessionRef => {
					if (ref === undefined) throw new Error("agent Session is not registered yet");
					return ref;
				},
			};
			let manager: Manager;
			try {
				const sessionManager = forkParent
					? SessionManager.forkFrom(parentSessionPath, project.cwd, childDir)
					: SessionManager.create(project.cwd, childDir);
				if (forkParent) {
					// A fork allocates its own leaf and writes it immediately, so the fork is
					// moved onto the claim before the Manager opens it: the history it carries
					// is the parent's, the address stays the task name.
					const forked = sessionManager.getSessionFile();
					if (forked === undefined) throw new Error("forked Session has no file");
					renameSync(forked, childPath);
				}
				manager = await options.managerFactory({
					cwd: project.cwd,
					agentDir: options.agentDir,
					modelRuntime: options.modelRuntime,
					sessionManager,
					// `setSessionFile` fills the claim — writing the header, or reloading what
					// the fork already wrote — instead of allocating a generated leaf.
					sessionPath: childPath,
					agentControl,
				});
			} catch (error) {
				// Nothing was registered, so the claim goes with the failure and a retry can
				// use the name.
				rmSync(childPath, { force: true });
				throw error;
			}
			// A full fork copies the parent's branch into the child's file, so the
			// child's own result cannot be read past the entry the copy ended at. Codex
			// reports the turn's text; the boundary is how a file scan can agree.
			let forkBoundary: string | undefined;
			if (forkParent) {
				const inherited = SessionManager.open(manager.sessionFile).getBranch();
				forkBoundary = inherited[inherited.length - 1]?.id;
			}
			try {
				const stem = stemFromSessionPath(project.sessionDir, manager.sessionFile);
				if (registry.byAddressAny(project.id, stem) !== undefined) {
					throw new Error(`Session already active: ${stem}`);
				}
				record = await registry.register(manager, {
					projectId: project.id,
					sessionId: manager.liveSessionId,
					stem,
				});
				ref = record.ref;
				liveManagers.add(manager);
				// The row's title is the canonical task name. Without it a child is titled
				// by its first message, which is the protocol envelope.
				await manager.renameSession(request.taskName);
				if (request.model !== undefined) {
					const model = splitModelRef(request.model);
					await manager.setModel(model.provider, model.modelId);
				}
				if (request.reasoningEffort !== undefined) {
					await manager.setThinkingLevel(request.reasoningEffort);
				}
				// A spawn is agent-initiated work, so it writes no queue place: Inbox and
				// Later are the user's attention list, and only a user's own prompt may put
				// a Session there. The child stays Archive (the absence of a place); the
				// sidebar draws live descendants of a queued Session from the queue
				// snapshot, so the tree is visible without joining the queue.
				// Bind before the first prompt: a fast turn can settle before
				// admission returns, and the completion event must not be lost.
				agent = bindControlledAgent(record, context, { model: request.model, boundary: forkBoundary });
				// Codex briefs a subagent before its first input: the team contract, which
				// is what tells the child its final answer leaves to its parent without a
				// tool call. The envelope alone names only the path. A full fork adds the
				// inherited-history boundary, because the copied branch is context, not
				// the child's own task.
				const childPolicy = subAgentPolicy(MAX_CONCURRENT_TURNS, forkParent);
				await manager.sendContextMessage(POLICY_CUSTOM_TYPE, childPolicy);
				rearmPolicy(manager, childPolicy);
				// The child's first input is Codex's NEW_TASK envelope: it names the
				// recipient — the child's own canonical path — and the sender, which is
				// how a subagent learns who and where it is.
				await agent.prompt(interAgentBody("NEW_TASK", context.path, context.parentPath, request.message));
			} catch (error) {
				if (agent !== undefined) await agent.close();
				else if (record !== undefined) await registry.collect(record);
				else await manager.dispose();
				throw error;
			}
			if (agent === undefined) throw new Error("agent Session was not registered");
			return agent;
		});
	}

	/** Load the Session an address names, for a fragment whose recipient has no
	 * runtime. Returns `undefined` when the file no longer exists. */
	const loadForDelivery = async (address: AgentAddress): Promise<Manager | undefined> => {
		const project = requireProject(address.projectId);
		const abs = resolveStemPath(project.sessionDir, address.stem);
		if (!existsSync(abs)) return undefined;
		const record = await registry.open(project, address.stem, abs);
		return managerFor(record.ref.sessionId);
	};

	const control: AgentControlService = createAgentControl({
		spawn: spawnControlledAgent,
		// A dormant child is loaded from the address the tree names: the file is the
		// identity, so a Worker restart or idle collection cannot make a known agent
		// unreachable. `registry.open` reuses a live registration when the browser
		// already has the Session open.
		resume: async (context: AgentResumeContext) => {
			if (disposed) throw new Error("worker is shutting down");
			const project = requireProject(context.caller.projectId);
			// The address is the path below the tree root, hung off the root's stem: the
			// caller's own stem carries it, so the caller's path measures the suffix to
			// strip. An absolute target may leave the caller's subtree, which is why the
			// suffix is measured from the caller rather than from the target.
			const stem = stemForAgentPath(context.caller.stem, context.callerPath, context.path);
			const abs = resolveStemPath(project.sessionDir, stem);
			if (!existsSync(abs)) return undefined;
			const record = await registry.open(project, stem, abs);
			return bindControlledAgent(record, context, {});
		},
		// Every durable address the control plane needs comes from the layout the
		// Worker owns: a spawner's address for a settlement, the root's for a reply.
		addressOf: (session, sessionPath, path) => ({
			projectId: session.projectId,
			stem: stemForAgentPath(session.stem, sessionPath, path),
		}),
		// A fragment is Codex's mailbox drain: it lands in the Session's context at
		// its next request and never starts work on the recipient's behalf.
		deliver: async (agentId, fragment, address) => {
			const manager = managerFor(agentId) ?? (address === undefined ? undefined : await loadForDelivery(address));
			if (manager === undefined) throw new Error(`agent with id ${agentId} not found`);
			// Only agent mail is transcript content; the collaboration brief is policy
			// the model reads and the human does not see.
			const mail =
				fragment.kind === "agent_message" ? { display: true, details: fragment.details } : { display: false };
			await manager.sendContextMessage(fragment.customType, fragment.content, mail);
			if (fragment.kind === "policy") rearmPolicy(manager, fragment.content);
		},
		// A collected Session has no turn left to steer, so it cannot wake a wait.
		watchInput: (agentId, listener) => managerFor(agentId)?.onInput(listener) ?? (() => {}),
		// The snapshot a wait compares against after installing its listener: input
		// admitted in between is still counted, so the wake cannot be lost.
		inputSequence: (agentId) => managerFor(agentId)?.inputSequence() ?? 0,
		// The tree root is a Session like any other but holds no control capability,
		// so its status comes from the runtime and the last execution outcome, not
		// from a record: a transcript read cannot tell an interrupted root from a
		// completed one.
		probe: async (agentId): Promise<AgentStatus | undefined> => {
			const manager = managerFor(agentId);
			const outcome = lastOutcomes.get(agentId);
			if (manager === undefined) return outcome === undefined ? undefined : settledStatus(outcome, undefined);
			if (manager.activity().phase !== "idle") return "running";
			const message = lastAssistantText(manager);
			return outcome === undefined
				? message === undefined
					? "pending_init"
					: { completed: message }
				: settledStatus(outcome, message);
		},
	});

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
				let createdRef: SessionRef | undefined;
				const manager = await options.managerFactory({
					cwd: project.cwd,
					agentDir: options.agentDir,
					modelRuntime: options.modelRuntime,
					agentControl: {
						service: control,
						parent: () => {
							if (createdRef === undefined) throw new Error("Session is not registered yet");
							return createdRef;
						},
					},
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
				createdRef = record.ref;
				liveManagers.add(manager);
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
					// The first prompt places the Session like any other message —
					// in Inbox — and a refused preflight restores the placement it
					// replaced.
					const admission = locations.promote(project.id, record.ref.stem);
					refreshQueue("full", "user");
					try {
						await manager.promptAdmitted(text, images);
					} catch (err) {
						locations.restore(project.id, record.ref.stem, admission);
						refreshQueue("full", "user");
						throw err;
					}
					emitHistoryChanged(project.id);
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
			if (record) {
				// Disposal aborts and finalizes the in-flight turn; the placement is
				// untouched, because a stop says nothing about where a Session
				// belongs. The finalized execution reports as aborted, which every
				// client can read for itself.
				await registry.collect(record);
			} else if (!(await sessionExistsAt(project, stem))) {
				throw new Error(`No such session: ${stem}`);
			}
			refreshQueue("full", "user");
		},

		trashSession: async (address) => {
			const project = requireProject(address.projectId);
			// Rejects the trash prefix itself, so a trashed stem can never be
			// re-addressed.
			const stem = normalizeStem(address.stem);
			// Children are stored under their spawner's stem, so a trash takes the
			// subtree: a child left behind would keep a parent address that no longer
			// resolves, and would keep running with no one to report to.
			const subtree = (): string[] =>
				subtreeStemsUnder(
					[
						...liveEntries()
							.filter((entry) => entry.ref.projectId === project.id)
							.map((entry) => entry.ref.stem),
						...scanDurableSessionIds(project).keys(),
					],
					stem,
				);
			// Stop first, unconditionally: disposal finalizes an in-flight turn,
			// which can create or advance the file, so the move must follow it.
			for (const target of subtree()) {
				const record = await registry.awaitSettled(project.id, target);
				if (record) await registry.collect(record);
			}
			// Re-read after the stop: a finalized turn may have created its file.
			const durable = scanDurableSessionIds(project);
			// The addressed Session must have a file to move. A descendant may not — a
			// child whose first turn never flushed has no file, but its runtime is gone
			// and its placement is all that is left to drop — and that is not a failure.
			if (!durable.has(stem)) throw new Error(`Session has no file to trash: ${stem}`);
			for (const target of subtree()) {
				// A Session that never flushed has no file to move: its runtime is gone
				// and the placement is all that is left to drop.
				if (durable.has(target)) trashStemFile(project.sessionDir, target);
				// The trashed Sessions leave discovery and the queue together: the move
				// takes the file out of the Project's namespace and the prune drops the
				// placement record keyed by the stem it was addressed at.
				locations.prune(project.id, target);
			}
			emitHistoryChanged(project.id);
			refreshQueue("full", "user");
		},

		// ── Session commands (target-addressed) ─────────────────────────
		prompt: async (target, text, images, model, thinkingLevel) => {
			const admission = admissionFor(target);
			// A submitted message places the Session in Inbox before the turn
			// starts, so the queue shows what the user is waiting on; a refused
			// preflight restores the placement it replaced.
			const token = locations.promote(target.projectId, target.stem);
			refreshQueue("full", "user");
			try {
				await admission.prompt(text, images, model, thinkingLevel);
			} catch (err) {
				locations.restore(target.projectId, target.stem, token);
				refreshQueue("full", "user");
				throw err;
			}
		},
		abort: async (target) => admissionFor(target).abort(),
		discardSteer: async (target) => admissionFor(target).discardSteer(),
		compact: async (target, customInstructions) => {
			const result = await admissionFor(target).compact(customInstructions);
			// The CompactionEntry is an appended entry: the row's message count and
			// last activity move, and the Project's cached history is stale.
			refreshQueue("full", "user");
			emitHistoryChanged(target.projectId);
			return result;
		},
		renameSession: async (target, name) => {
			await admissionFor(target).renameSession(name);
			// The name is row content and history content alike.
			refreshQueue("full", "user");
			emitHistoryChanged(target.projectId);
		},
		setLabel: async (target, entryId, label) => admissionFor(target).setLabel(entryId, label),
		navigate: async (target, entryId) => admissionFor(target).navigate(entryId),
		recoverTurn: async (target) => {
			const admission = admissionFor(target);
			// Recovery starts a turn on both of its paths, so it places the
			// Session in Inbox like any other submitted work — and a refusal
			// restores the placement it replaced.
			const token = locations.promote(target.projectId, target.stem);
			refreshQueue("full", "user");
			try {
				return await admission.recoverTurn();
			} catch (err) {
				locations.restore(target.projectId, target.stem, token);
				refreshQueue("full", "user");
				throw err;
			}
		},

		// ── Queries ─────────────────────────────────────────────────────
		listSessions: async (projectId: string, max?: number, cursor?: SessionListCursor | null): Promise<SessionPage> =>
			catalog.listSessions(projectId, max, cursor ?? null, liveEntries(), locations),
		// The materialized slice: the same state the deltas are diffed against,
		// so a seed and the delta that follows it cannot disagree. A query is a
		// full rebuild, which is also where external filesystem edits are
		// discovered — they publish as an ordinary delta (ADR 24).
		listQueue: async () => {
			refreshQueue("full", "runtime");
			return { sessions: [...publishedQueue.values()].sort(compareQueueRows), version: queueVersion };
		},

		setSessionLocation: async (address: SessionAddress, location: SessionLocation): Promise<void> => {
			const project = requireProject(address.projectId);
			const stem = normalizeStem(address.stem);
			// Archived history is not being worked on, so the move ends the
			// runtime first — disposal flushes the turn, which is also what makes
			// the existence probe below see an unflushed Session's file.
			if (location === "archive") {
				const record = await registry.awaitSettled(project.id, stem);
				if (record) await registry.collect(record);
			}
			if (!(await sessionExistsAt(project, stem))) throw new Error(`No such session: ${stem}`);
			// Durable-or-fail: a failed write leaves the store untouched, so a retry
			// re-attempts it instead of reporting a move that never landed.
			locations.place(project.id, stem, location);
			// The row changes place, and the Project's cached history groups it
			// differently.
			refreshQueue("full", "user");
			emitHistoryChanged(project.id);
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
				emit({ kind: "pinned_models_changed" });
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
