import { join } from "node:path";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai/compat";
import type { AgentSession, AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	ModelRuntime,
	type ContextUsage as PiContextUsage,
	resolveModelScopeWithDiagnostics,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	applyEvent,
	applyPatch,
	buildInitialSync,
	type ContextUsage,
	type Document,
	GIT_STAMP_CUSTOM_TYPE,
	type ImageContent,
	initFromEntries,
	type JsonValue,
	type Patch,
	type PatchMessage,
	type PatchOp,
	type PrefixCursor,
	type ReconcileOptions,
	type ReplaceMessage,
	reconcile,
	type ScopedModelInfo,
	setAtPath,
} from "../core/index.ts";
import { createGitStampExtension } from "./git-stamp-extension.ts";

// ============================================================================
// Helpers
// ============================================================================

/** Convert pi's ContextUsage to the bridge's ContextUsage type. */
function toBridgeContextUsage(pi: PiContextUsage | undefined): ContextUsage | null {
	if (!pi) return null;
	return {
		tokens: pi.tokens,
		contextWindow: pi.contextWindow,
		percent: pi.percent,
	};
}

/** Get context usage from session, return it (or null) for inclusion in ReconcileOptions. */
function getContextUsageOption(session: AgentSession | undefined): ContextUsage | null | undefined {
	return toBridgeContextUsage(session?.getContextUsage());
}

// ============================================================================
// Types
// ============================================================================

export interface CreateManagerOptions {
	cwd?: string;
	agentDir?: string;
	/** Session path for targeting a specific session (v2 attachManager). */
	sessionPath?: string;

	/** Injected model runtime. Default: ModelRuntime.create({ authPath }) */
	modelRuntime?: ModelRuntime;
	/** Injected settings. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** Pre-built session manager (e.g. fixture-resumed). Default: SessionManager.create(cwd) */
	sessionManager?: SessionManager;
	/** Pre-selected model. Default: resolved from modelRuntime/settings */
	model?: Model<string>;
	/** Custom tools to register. */
	customTools?: ToolDefinition[];
	/** Write git identity stamps (ADR 10). Default: true. Test seam. */
	gitStamps?: boolean;
}

/**
 * One attached wire Connection, addressed individually (ADR 09). The Manager
 * relays live patches via onPatch and initial-sync frames (replace snapshot
 * or cursor delta, both carrying sessionId) via onInitialSync — at attach
 * and after every session rebind.
 */
export interface ConnectionHandle {
	onPatch(patch: Patch): void;
	onInitialSync(frame: PatchMessage | ReplaceMessage): void;
	onExit(): void;
}

export interface Manager {
	/** The canonical Document — mutated by the Manager, read by Connections. */
	document: Document;

	/** The current session id (from SessionManager). */
	readonly liveSessionId: string;

	/** The instance cwd this Manager is bound to. */
	readonly cwd: string;

	// ── Callbacks (replaces BridgeBus) ────────────────────────────────────

	/** Register a patch listener. Returns unsubscribe function. */
	onPatch(listener: (patch: Patch) => void): () => void;
	/** Register an initial-sync listener for raw-object-mode tests. */
	onReplace(listener: (document: Document) => void): () => void;
	/** Register a listener for Manager exit. Returns unsubscribe function. */
	onExit(listener: () => void): () => void;
	/** Attach a Connection. Emits its initial sync synchronously (ADR 09):
	 * a delta patch when `cursor` validates against the current session,
	 * otherwise a full replace. */
	addConnection(handle: ConnectionHandle, cursor?: PrefixCursor | null): void;
	/** Detach a Connection. Removes its handle. */
	removeConnection(handle: ConnectionHandle): void;
	/**
	 * Register a listener for session-settled events (agent_settled / turn_end).
	 * The first such event on a new session triggers the deferred file write,
	 * so listeners can rescan sessions to pick up the now-on-disk metadata.
	 * Returns unsubscribe function.
	 */
	onSettled(listener: () => void): () => void;

	// ── Session verbs ─────────────────────────────────────────────────────

	prompt(text: string, images?: ImageContent[]): Promise<void>;
	abort(): Promise<void>;
	/** Clear all pending steer/follow-up messages from the session queue. */
	discardSteer(): Promise<void>;
	setModel(provider: string, modelId: string): Promise<void>;
	setThinkingLevel(level: string): Promise<void>;
	renameSession(name: string): Promise<void>;
	navigate(entryId: string | null): Promise<void>;
	switchSession(sessionPath: string, cursor?: PrefixCursor | null, initiator?: ConnectionHandle): Promise<void>;
	newSession(): Promise<void>;

	// ── Lifecycle ─────────────────────────────────────────────────────────

	dispose(): Promise<void>;
}

// ============================================================================
// createManager
// ============================================================================

export async function createManager(options: CreateManagerOptions = {}): Promise<Manager> {
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getAgentDir();
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create({ authPath: join(agentDir, "auth.json") }));
	let sessionManager = options.sessionManager ?? SessionManager.create(cwd);

	if (options.sessionPath) {
		sessionManager.setSessionFile(options.sessionPath);
	}

	const patchListeners = new Set<(patch: Patch) => void>();
	const replaceListeners = new Set<(document: Document) => void>();
	const settledListeners = new Set<() => void>();
	const exitListeners = new Set<() => void>();
	const connectionHandles = new Set<ConnectionHandle>();

	// ADR 09: the switch verb records the initiating Connection's cursor so
	// the rebind emission can send it a delta while every other Connection
	// receives a full replace.
	let pendingSwitchCursor: PrefixCursor | null = null;
	let pendingSwitchInitiator: ConnectionHandle | null = null;

	// ── Event processing (captured in closure; rebound on session switch) ──

	let unsubscribe: (() => void) | null = null;
	const emitPatch = (patch: Patch) => {
		for (const l of patchListeners) l(patch);
		for (const h of connectionHandles) h.onPatch(patch);
	};
	const emitReplace = () => {
		for (const l of replaceListeners) l(document);
	};
	/** Per-Connection initial sync (ADR 09): delta for the initiator's cursor,
	 * full replace for everyone else. Synchronous — runs inside the rebind
	 * callback, so no later patch can interleave ahead of it. */
	const emitInitialSync = (cursor: PrefixCursor | null, initiator: ConnectionHandle | null) => {
		const piEntries = sessionManager.getEntries();
		const sessionId = sessionManager.getSessionId();
		for (const handle of connectionHandles) {
			handle.onInitialSync(buildInitialSync(document, piEntries, sessionId, handle === initiator ? cursor : null));
		}
	};

	const processEvent = (event: AgentSessionEvent) => {
		const patches: Patch[] = [];

		const patch = applyEvent(document, event);
		if (patch) {
			document = applyPatch(document, patch.ops);
			patches.push(patch);
		}

		if (event.type === "turn_end" || event.type === "agent_settled") {
			const recPatch = reconcile(document, sessionManager.getEntries(), {
				model: session?.model ? { provider: session.model.provider, modelId: session.model.id } : undefined,
				thinkingLevel: session?.thinkingLevel ?? "off",
				// Sync context usage after turn end — pi's getContextUsage() is now
				// authoritative (compaction gaps, trailing estimates, percentage).
				// Bundled into the reconcile patch so atomic with the seal.
				contextUsage: getContextUsageOption(session),
			});
			if (recPatch) {
				document = applyPatch(document, recPatch.ops);
				patches.push(recPatch);
			}
			// Notify connections that the session has settled — the first turn
			// after newSession writes the session file, and listeners can rescan
			// to pick up the now-on-disk metadata (name, message count, etc.).
			for (const l of settledListeners) l();
		}

		for (const p of patches) emitPatch(p);
	};

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: runtimeCwd, sessionManager: sm }) => {
		const services: AgentSessionServices = await createAgentSessionServices({
			cwd: runtimeCwd,
			agentDir,
			settingsManager,
			modelRuntime,
			// ADR 10: the bridge bundles the git-stamp writer; it loads for
			// every runtime (initial bind and each session rebind).
			resourceLoaderOptions:
				options.gitStamps === false
					? undefined
					: {
							extensionFactories: [
								{
									name: GIT_STAMP_CUSTOM_TYPE,
									factory: createGitStampExtension(),
									hidden: true,
								},
							],
						},
		});
		const result = await createAgentSessionFromServices({
			services,
			sessionManager: sm,
			model: options.model,
			customTools: options.customTools,
		});
		return {
			...result,
			services,
			diagnostics: services.diagnostics,
		};
	};

	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager,
	});

	let session = runtime.session;
	await session.bindExtensions({});

	// Set up rebindSession callback for switchSession/newSession
	runtime.setRebindSession(async (newSession: AgentSession) => {
		// Unsubscribe from old session's events
		if (unsubscribe) {
			unsubscribe();
			unsubscribe = null;
		}

		// Bind extensions on new session
		await newSession.bindExtensions({});

		// Re-bootstrap the canonical Document from the new session's entries
		const newEntries = newSession.sessionManager.getEntries();
		let newDoc = initFromEntries(newEntries);
		if (newSession.model) {
			newDoc = setAtPath(newDoc, "/status/model", {
				provider: newSession.model.provider,
				modelId: newSession.model.id,
			} as unknown as JsonValue);
		}
		newDoc = setAtPath(newDoc, "/status/thinkingLevel", newSession.thinkingLevel);
		// Sync context usage for the new session into the document before the
		// replace push so the full snapshot carries the value.
		{
			const cu = getContextUsageOption(newSession);
			if (cu !== undefined) {
				newDoc = setAtPath(newDoc, "/status/contextUsage", cu as unknown as JsonValue);
			}
		}

		// Resolve scoped models from settings (global ~/.pi config) if the new session has none
		if (newSession.scopedModels.length === 0 && settingsManager) {
			const patterns = settingsManager.getEnabledModels();
			if (patterns && patterns.length > 0) {
				const { scopedModels: resolved } = await resolveModelScopeWithDiagnostics(patterns, modelRuntime);
				if (resolved.length > 0) {
					newSession.setScopedModels(
						resolved.map((sm) => ({
							model: sm.model,
							thinkingLevel: sm.thinkingLevel,
						})),
					);
				}
			}
		}

		// Sync scoped models from the session
		{
			const scoped: ScopedModelInfo[] = newSession.scopedModels.map((sm) => ({
				provider: sm.model.provider,
				id: sm.model.id,
				name: sm.model.name ?? sm.model.id,
				thinkingLevel: sm.thinkingLevel,
			}));
			newDoc = setAtPath(newDoc, "/scopedModels", scoped as unknown as JsonValue);
		}

		// Replace the document reference and sessionManager
		sessionManager = newSession.sessionManager;
		document = newDoc;

		// Re-subscribe on new session
		session = newSession;
		unsubscribe = newSession.subscribe(processEvent);

		// Push full replace to raw-mode listeners, then per-Connection initial
		// sync (ADR 09): the initiator's cursor may yield a delta patch.
		emitReplace();
		emitInitialSync(pendingSwitchCursor, pendingSwitchInitiator);
	});

	// Bootstrap the canonical Document
	let document: Document = initFromEntries(sessionManager.getEntries());
	if (session.model) {
		document = setAtPath(document, "/status/model", {
			provider: session.model.provider,
			modelId: session.model.id,
		} as unknown as JsonValue);
	}
	document = setAtPath(document, "/status/thinkingLevel", session.thinkingLevel);
	// Sync initial context usage into the document (no listeners subscribed yet
	// during bootstrap, so this doesn't emit a patch). The first `replace` push
	// sent by addConnection will include the value.
	{
		const cu = getContextUsageOption(session);
		if (cu !== undefined) {
			document = setAtPath(document, "/status/contextUsage", cu as unknown as JsonValue);
		}
	}

	// Resolve scoped models from settings (global ~/.pi config) if the session has none
	if (session.scopedModels.length === 0 && settingsManager) {
		const patterns = settingsManager.getEnabledModels();
		if (patterns && patterns.length > 0) {
			const { scopedModels: resolved } = await resolveModelScopeWithDiagnostics(patterns, modelRuntime);
			if (resolved.length > 0) {
				session.setScopedModels(
					resolved.map((sm) => ({
						model: sm.model,
						thinkingLevel: sm.thinkingLevel,
					})),
				);
			}
		}
	}

	// Sync scoped models from the session
	{
		const scoped: ScopedModelInfo[] = session.scopedModels.map((sm) => ({
			provider: sm.model.provider,
			id: sm.model.id,
			name: sm.model.name ?? sm.model.id,
			thinkingLevel: sm.thinkingLevel,
		}));
		document = setAtPath(document, "/scopedModels", scoped as unknown as JsonValue);
	}

	// Subscribe to pi events
	unsubscribe = session.subscribe(processEvent);

	function tryReconcile(opts: ReconcileOptions): void {
		if (document.status.isStreaming || document.status.isCompacting) return;
		const recPatch = reconcile(document, sessionManager.getEntries(), {
			...opts,
			contextUsage: getContextUsageOption(session),
		});
		if (recPatch) {
			document = applyPatch(document, recPatch.ops);
			emitPatch(recPatch);
		}
	}

	// ── Manager object ────────────────────────────────────────────────────

	const mgr: Manager = {
		get document() {
			return document;
		},

		get liveSessionId() {
			return sessionManager.getSessionId();
		},

		get cwd() {
			return runtime.cwd;
		},

		onPatch(listener) {
			patchListeners.add(listener);
			return () => patchListeners.delete(listener);
		},
		onReplace(listener) {
			replaceListeners.add(listener);
			return () => replaceListeners.delete(listener);
		},
		addConnection(handle, cursor = null) {
			connectionHandles.add(handle);
			// Initial sync is emitted synchronously at attach, before any later
			// live patch on this Connection (ADR 09 invariant 7).
			handle.onInitialSync(
				buildInitialSync(document, sessionManager.getEntries(), sessionManager.getSessionId(), cursor),
			);
		},
		removeConnection(handle) {
			connectionHandles.delete(handle);
		},
		onExit(listener) {
			exitListeners.add(listener);
			return () => exitListeners.delete(listener);
		},
		onSettled(listener) {
			settledListeners.add(listener);
			return () => settledListeners.delete(listener);
		},

		async prompt(text: string, images?: ImageContent[]) {
			await session.prompt(text, {
				source: "rpc",
				streamingBehavior: "steer",
				preflightResult: () => {},
				...(images && images.length > 0 ? { images } : {}),
			});
		},

		async abort() {
			// Server Stop contract: stop the assistant and clear the steer
			// queue. Clearing must precede the abort's idle-wait — otherwise
			// the post-abort auto-continue (_handlePostAgentRun →
			// hasQueuedMessages → agent.continue → steeringQueue.drain)
			// delivers the queued steer as a new turn and abort() never
			// returns. The clear is destructive by design; preserving the
			// draft text is the client's job — it reads /status/pendingSteer
			// and refills its input box before sending Stop.
			session.clearQueue();
			await session.abort();
		},

		async discardSteer() {
			// clearQueue is synchronous: it fires queue_update before this
			// resolves, so the patch push lands ahead of the RPC reply
			// (effects-via-push, §7.13).
			session.clearQueue();
		},

		async setModel(provider: string, modelId: string) {
			const model = modelRuntime.getModel(provider, modelId);
			if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
			await session.setModel(model);
			tryReconcile({
				model: session.model ? { provider: session.model.provider, modelId: session.model.id } : undefined,
			});
		},

		async setThinkingLevel(level: string) {
			session.setThinkingLevel(level as ThinkingLevel);
			tryReconcile({ thinkingLevel: session.thinkingLevel });
		},

		async renameSession(name: string) {
			await session.setSessionName(name);
		},

		async navigate(entryId: string | null) {
			if (entryId === null) {
				sessionManager.resetLeaf();
			} else {
				sessionManager.branch(entryId);
			}
			// Rebuild agent state from the new branch context.
			// Intentional coupling to pi internals — agent.state.messages
			// retains the old full conversation path after branching; the
			// next prompt would send stale history to the LLM.
			session.agent.state.messages = sessionManager.buildSessionContext().messages;
			if (document.status.leafId !== entryId) {
				document = setAtPath(document, "/status/leafId", entryId ?? null);
				const leafOp: PatchOp = {
					op: "replace",
					path: "/status/leafId",
					value: (entryId ?? null) as unknown as JsonValue,
				};
				emitPatch({ ops: [leafOp] });
			}
		},

		async switchSession(
			sessionPath: string,
			cursor: PrefixCursor | null = null,
			initiator: ConnectionHandle | null = null,
		) {
			// The sidebar sessions list can contain a stub row for the live
			// session — a bare session id (UUID), because the new session has
			// no file on disk yet. Treating that id as a file path would make
			// SessionManager.open() resolve `cwd/<uuid>` and create a junk
			// file on the first message. The manager is already attached to
			// that session, so switching to it is a no-op.
			if (sessionPath === sessionManager.getSessionId()) return;
			pendingSwitchCursor = cursor;
			pendingSwitchInitiator = initiator;
			try {
				// A pre-rebind failure (bad path, cwd assert, cancellation)
				// throws before the rebind callback, so no initial sync is sent
				// and the caller's reply is ok:false (ADR 09 rebind failure path).
				await runtime.switchSession(sessionPath);
			} finally {
				pendingSwitchCursor = null;
				pendingSwitchInitiator = null;
			}
		},

		async newSession() {
			await runtime.newSession();
		},

		async dispose() {
			// 1. Save: finalize + flush the in-flight turn. Listeners are still
			//    attached, so client tabs see the final patches before manager_exit.
			await session.abort();
			// 2. Teardown: notify Connections. Each Connection's onExit handler
			//    sends manager_exit (last frame) and self-detaches its callbacks.
			for (const l of exitListeners) l();
			for (const handle of connectionHandles) handle.onExit();
			// 3. Unsubscribe from pi events.
			if (unsubscribe) {
				unsubscribe();
				unsubscribe = null;
			}
			// 4. Tear down the pi runtime.
			await runtime.dispose();
		},
	};

	return mgr;
}
