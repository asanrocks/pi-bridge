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
	getDefaultSessionDir,
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
	type SessionRef,
	setAtPath,
} from "../core/index.ts";
import { createGitStampExtensionWithTrigger, type GitStampTrigger } from "./git-stamp-extension.ts";

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
	/** Resume a session from this file (ADR 11 `openSession`). Omit to create a
	 * fresh, initially unflushed session (`newSession`). */
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
 * relays live patches via onPatch and the initial-sync frame (replace snapshot
 * or cursor delta, both carrying the session reference) via onInitialSync at
 * attach. There is no rebind: an activation serves exactly one session for its
 * lifetime (ADR 11).
 */
export interface ConnectionHandle {
	onPatch(patch: Patch): void;
	onInitialSync(frame: PatchMessage | ReplaceMessage): void;
}

export interface Manager {
	/** The canonical Document — mutated by the Manager, read by Connections. */
	document: Document;

	/** The current session id (from SessionManager). */
	readonly liveSessionId: string;

	/** The instance cwd this Manager is bound to. */
	readonly cwd: string;

	/** Absolute session file path. Always set: pi allocates the filename at
	 * session creation, before the first flush. Never null. */
	readonly sessionFile: string;

	/** Session header creation timestamp (ISO). Orders an unflushed session
	 * before its first flush (ADR 11). */
	readonly createdAt: string;

	// ── Callbacks (replaces BridgeBus) ────────────────────────────────────

	/** Register a patch listener. Returns unsubscribe function. */
	onPatch(listener: (patch: Patch) => void): () => void;
	/** Attach a Connection. Emits its initial sync synchronously (ADR 09):
	 * a delta patch when `cursor` validates against the current session,
	 * otherwise a full replace. */
	addConnection(handle: ConnectionHandle, session: SessionRef, cursor?: PrefixCursor | null): void;
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
	/** Run a user `!` command in the instance cwd. Recorded as a
	 * `bashExecution` entry — also an ADR 10 user_bash_end observation
	 * boundary. */
	executeBash(command: string, options?: { excludeFromContext?: boolean }): Promise<void>;
	abort(): Promise<void>;
	/** Clear all pending steer/follow-up messages from the session queue. */
	discardSteer(): Promise<void>;
	setModel(provider: string, modelId: string): Promise<void>;
	setThinkingLevel(level: string): Promise<void>;
	renameSession(name: string): Promise<void>;
	navigate(entryId: string | null): Promise<void>;

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
	// Pin the session directory to this Manager's agentDir. SessionManager.create
	// would otherwise derive it from the process-global agent dir, so a daemon
	// started with a custom agentDir (tests, embeddings) would allocate new
	// sessions outside its Project's session storage (ADR 11).
	const sessionDir = getDefaultSessionDir(cwd, agentDir);
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd, sessionDir);

	if (options.sessionPath) {
		sessionManager.setSessionFile(options.sessionPath);
	}

	const patchListeners = new Set<(patch: Patch) => void>();
	const settledListeners = new Set<() => void>();
	const connectionHandles = new Set<ConnectionHandle>();
	// ADR 10: one bundle per Manager. An activation serves exactly one session
	// for its lifetime (ADR 11), so the host trigger never rebinds.
	const gitStampBundle = createGitStampExtensionWithTrigger();

	// ADR 10 v2: host-side user-bash observations. The trigger enqueues into
	// the extension's serialized stream; null until the runtime binds (the
	// factory sets its target) or when stamps are disabled.
	let gitStampTrigger: GitStampTrigger | null = null;

	// ── Event processing (captured in closure) ──

	let unsubscribe: (() => void) | null = null;
	const emitPatch = (patch: Patch) => {
		for (const l of patchListeners) l(patch);
		for (const h of connectionHandles) h.onPatch(patch);
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

		// ADR 10 v2: a persisted user bash entry (a `!`/`!!` command) is a Git
		// observation boundary. Fired after the entry is applied and published,
		// so the resulting stamp normally parents onto the bash entry. Deferred
		// bash (queued while streaming, flushed after the turn) is observed at
		// its actual persistence boundary here too.
		if (
			gitStampTrigger &&
			event.type === "entry_appended" &&
			event.entry.type === "message" &&
			event.entry.message.role === "bashExecution"
		) {
			gitStampTrigger.observe("user_bash_end", { cwd, sessionManager });
		}
	};

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: runtimeCwd, sessionManager: sm }) => {
		const services: AgentSessionServices = await createAgentSessionServices({
			cwd: runtimeCwd,
			agentDir,
			settingsManager,
			modelRuntime,
			// ADR 10: the bridge bundles the git-stamp writer into the
			// runtime's extension set.
			resourceLoaderOptions:
				options.gitStamps === false
					? undefined
					: {
							extensionFactories: [
								{
									name: GIT_STAMP_CUSTOM_TYPE,
									factory: gitStampBundle.factory,
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
	// The trigger is live from here on — the factory already bound during
	// runtime creation, so its enqueue target is set. Null when disabled.
	gitStampTrigger = options.gitStamps === false ? null : gitStampBundle.trigger;

	const session = runtime.session;
	await session.bindExtensions({});

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

		get sessionFile() {
			// pi allocates the filename at session creation, so this is always
			// set — including for a session that has not flushed yet.
			return sessionManager.getSessionFile() ?? "";
		},

		get createdAt() {
			return sessionManager.getHeader()?.timestamp ?? new Date(0).toISOString();
		},

		onPatch(listener) {
			patchListeners.add(listener);
			return () => patchListeners.delete(listener);
		},
		addConnection(handle, sessionRef, cursor = null) {
			connectionHandles.add(handle);
			// Initial sync is emitted synchronously at attach, before any later
			// live patch on this Connection (ADR 09 invariant 7).
			handle.onInitialSync(buildInitialSync(document, sessionManager.getEntries(), sessionRef, cursor));
		},
		removeConnection(handle) {
			connectionHandles.delete(handle);
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

		async executeBash(command: string, options?: { excludeFromContext?: boolean }) {
			await session.executeBash(command, undefined, options);
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

		async dispose() {
			// 1. Save: finalize + flush the in-flight turn. Listeners are still
			//    attached, so client tabs see the final patches before teardown.
			await session.abort();
			// 2. Unsubscribe from pi events.
			if (unsubscribe) {
				unsubscribe();
				unsubscribe = null;
			}
			// 3. Tear down the pi runtime.
			await runtime.dispose();
		},
	};

	return mgr;
}
