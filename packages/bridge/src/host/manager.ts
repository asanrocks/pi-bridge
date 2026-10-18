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
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	applyEvent,
	applyPatch,
	buildInitialSync,
	type ContextUsage,
	computeRecoverableTurn,
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
	type RecoverableTurnKind,
	type ReplaceMessage,
	reconcile,
	type SessionRef,
	setAtPath,
} from "../core/index.ts";
import { buildInterruptedToolsRelay } from "../core/recovery.ts";
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

/** True when the parent chain of `parentId` hits an id the Document does not
 * hold — the entry is parented into a suffix only the session file knows.
 * The walk stops at the first known ancestor, so it only ever walks the
 * current turn's in-flight suffix, not the whole history. */
function hasUnknownAncestor(doc: Document, parentId: string | null | undefined): boolean {
	let cursor = parentId ?? null;
	while (cursor !== null) {
		const entry = doc.entries[cursor];
		if (!entry) return true;
		cursor = entry.parentId;
	}
	return false;
}

/** The repair per recovery kind (ADR 16): whether recovery branches past
 * the dead entry (the navigate machinery), and how the run restarts —
 * silently (no transcript addition) or with a visible relay prompt. */
const RECOVERY_REPAIRS: Record<RecoverableTurnKind, { branch: boolean; restart: "continue" | "prompt" }> = {
	failedTurn: { branch: true, restart: "continue" },
	unfinishedTurn: { branch: false, restart: "continue" },
	interruptedTools: { branch: true, restart: "prompt" },
};

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
	/** Admit a prompt without awaiting the turn: resolves once pi's preflight
	 * accepts it (model/auth validated, message enqueued — the turn runs on in
	 * the background), rejects if admission fails. A rejection *after*
	 * admission never surfaces here; it becomes document state. Used by the
	 * daemon's text-bearing `newSession` (ADR 12 slice). */
	promptAdmitted(text: string, images?: ImageContent[]): Promise<void>;
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
	/** Set or clear a user-defined label on one entry (pi `LabelEntry`, a
	 * metadata-only append that never enters LLM context). An empty string
	 * clears. Rejected while a turn is in flight (the append lands at the
	 * session leaf). */
	setLabel(entryId: string, label: string): Promise<void>;
	navigate(entryId: string | null): Promise<void>;
	/** Recover the broken tail turn (ADR 16). Two actions (ADR 16
	 * terminology): "retry" — silently re-request from a clean boundary
	 * (`failedTurn`: branch past the dead assistant; `unfinishedTurn`: bare
	 * continue of the already-valid tail); "continue" — branch past the dead
	 * turn and send a visible "Continue." user message (`interruptedTools`:
	 * dangling calls or a tool terminated mid-run). Refuses (throws) when the
	 * tail is not recoverable or a turn is in flight. Returns which ran. The
	 * silent continuation is tracked by the Manager: `abort` and `dispose`
	 * await it, since pi's own idle-wait cannot see it. */
	recoverTurn(): Promise<"retry" | "continue">;

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

	// In-flight tool anchors: toolCallId → host monotonic ms at
	// tool_execution_start. A monotonic clock (not Date.now) keeps a wall-clock
	// adjustment mid-run from skewing the elapsed. Bridge-only, in-memory, never
	// persisted; projected into `status.inFlightTools` as the elapsed at emission
	// time. The client rebases it onto its own clock, so a skewed browser clock
	// stays correct.
	const inFlightStart = new Map<string, number>();
	const inFlightElapsed = (): Record<string, number> => {
		const now = performance.now();
		const out: Record<string, number> = {};
		for (const [id, startedAt] of inFlightStart) out[id] = Math.max(0, now - startedAt);
		return out;
	};

	// ── Event processing (captured in closure) ──

	let unsubscribe: (() => void) | null = null;
	const emitPatch = (patch: Patch) => {
		for (const l of patchListeners) l(patch);
		for (const h of connectionHandles) h.onPatch(patch);
	};

	const processEvent = (event: AgentSessionEvent) => {
		const patches: Patch[] = [];

		// An appended entry can reference ids only the session file knows (the
		// streaming assistant is a `pending:` provisional until the seal; the
		// git-stamp extension parents on the real persisted id). Applying it
		// would move the leaf onto an unresolvable chain — the path walk breaks,
		// the ViewModel collapses, and the seal restore remounts every turn.
		// Such entries defer to the seal instead: reconcile discovers them from
		// the file (the same path that picks up silently-appended entries), under
		// its normal pairing conditions. Known-parent appends (prompt stamps,
		// bash entries and their user_bash_end stamps) still apply live.
		const orphaned = event.type === "entry_appended" && hasUnknownAncestor(document, event.entry.parentId);

		// Ephemeral in-flight anchor — bridge-only, never persisted. A whole-object
		// replace avoids toolCallId path escaping (ids are opaque). The client
		// rebases the value onto its own clock, so only "how long ago" matters.
		// Merged into the event's own patch so one tool event is one patch (the
		// mirror-sync invariant holds per emitted patch).
		const inFlightOps: PatchOp[] = [];
		if (event.type === "tool_execution_start") {
			inFlightStart.set(event.toolCallId, performance.now());
			inFlightOps.push({ op: "replace", path: "/status/inFlightTools", value: inFlightElapsed() });
		} else if (event.type === "tool_execution_end" && inFlightStart.delete(event.toolCallId)) {
			inFlightOps.push({ op: "replace", path: "/status/inFlightTools", value: inFlightElapsed() });
		}

		const eventPatch = orphaned ? null : applyEvent(document, event);
		const ops = [...(eventPatch?.ops ?? []), ...inFlightOps];
		if (ops.length > 0) {
			document = applyPatch(document, ops);
			patches.push({ ops });
		}

		if (event.type === "turn_end" || event.type === "agent_settled") {
			const recPatch = boundaryReconcile(event.type === "agent_settled");
			if (recPatch) {
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
	// ADR 16: a resumed session can carry a broken tail (terminal error or
	// dangling tool calls) — the first replace a client receives already
	// carries the recovery kind, so the affordance is there on first paint.
	document = setAtPath(document, "/status/recoverableTurn", computeRecoverableTurn(document)?.kind ?? null);

	// Subscribe to pi events
	unsubscribe = session.subscribe(processEvent);

	// ADR 16: the recovery kind of the current leaf path's tail. Recomputed at
	// every idle boundary (settle, tryReconcile), on navigate, and at boot.
	const recoverableTurnKindOf = (doc: Document): RecoverableTurnKind | null =>
		computeRecoverableTurn(doc)?.kind ?? null;

	// Publish a leaf move (branch/reset) plus the re-derived recovery kind in
	// one patch, so a client never renders a recovered turn parented onto the
	// abandoned path (effects-via-push, §7.13).
	const publishLeaf = (entryId: string | null): void => {
		const ops: PatchOp[] = [];
		if (document.status.leafId !== entryId) {
			document = setAtPath(document, "/status/leafId", entryId);
			ops.push({ op: "replace", path: "/status/leafId", value: (entryId ?? null) as unknown as JsonValue });
		}
		const kind = recoverableTurnKindOf(document);
		if ((document.status.recoverableTurn ?? null) !== kind) {
			document = setAtPath(document, "/status/recoverableTurn", kind);
			ops.push({ op: "replace", path: "/status/recoverableTurn", value: kind as unknown as JsonValue });
		}
		if (ops.length > 0) emitPatch({ ops });
	};

	/** Turn-boundary reconcile shared by the event path and the recovery
	 * continuation's compensation (ADR 16). Applies to the Document and
	 * returns the patch for the caller to emit in event order. Syncs model,
	 * thinking level, and context usage — pi's getContextUsage() is
	 * authoritative after a turn (compaction gaps, trailing estimates,
	 * percentage), bundled into one patch so it is atomic with the seal — and
	 * at settle boundaries re-derives the recovery kind (mid-run turn_end
	 * boundaries are unstable: results still arriving). */
	const boundaryReconcile = (settle: boolean): Patch | null => {
		const recPatch = reconcile(document, sessionManager.getEntries(), {
			model: session?.model ? { provider: session.model.provider, modelId: session.model.id } : undefined,
			thinkingLevel: session?.thinkingLevel ?? "off",
			contextUsage: getContextUsageOption(session),
			...(settle ? { recoverableTurn: recoverableTurnKindOf(document) } : {}),
		});
		if (recPatch) document = applyPatch(document, recPatch.ops);
		return recPatch;
	};

	// ADR 16: an in-flight recovery continuation (agent.continue(), which runs
	// outside pi's _runAgentPrompt wrapper). AgentSession.isStreaming stays
	// false while it runs, so session.abort()'s idle-wait does not cover it —
	// the Manager tracks the run itself, and abort/dispose await it before
	// treating the session as settled.
	let recoveryRun: Promise<void> | null = null;
	const settleRecoveryRun = async (): Promise<void> => {
		if (recoveryRun) await recoveryRun.catch(() => {});
	};

	function tryReconcile(opts: ReconcileOptions): void {
		if (document.status.isStreaming || document.status.isCompacting) return;
		const recPatch = reconcile(document, sessionManager.getEntries(), {
			...opts,
			contextUsage: getContextUsageOption(session),
			recoverableTurn: recoverableTurnKindOf(document),
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
			// Refresh the in-flight anchors so a (re)connecting client recovers the
			// elapsed of tools already running. Not emitted as a patch: live clients
			// tick from their own local anchor, and only the fresh snapshot needs it.
			if (inFlightStart.size > 0) {
				document = applyPatch(document, [
					{ op: "replace", path: "/status/inFlightTools", value: inFlightElapsed() },
				]);
			}
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

		promptAdmitted(text: string, images?: ImageContent[]) {
			// pi's preflightResult fires exactly once before the turn starts (or
			// rethrows after preflightResult(false) on refusal), so it is the
			// admission signal. After admission the turn's own rejection is
			// document state, not this promise's — swallow it so the
			// fire-and-forget turn never leaks an unhandled rejection.
			return new Promise<void>((resolve, reject) => {
				let admitted = false;
				session
					.prompt(text, {
						source: "rpc",
						streamingBehavior: "steer",
						preflightResult: () => {
							admitted = true;
							resolve();
						},
						...(images && images.length > 0 ? { images } : {}),
					})
					.then(
						() => {
							// Belt for a resolution path pi takes without calling preflight —
							// resolve instead of hanging.
							if (!admitted) resolve();
						},
						(err) => {
							if (!admitted) reject(err instanceof Error ? err : new Error(String(err)));
						},
					);
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
			// A recovery continuation is invisible to session.abort()'s idle-wait
			// (ADR 16); await it so Stop's flush semantics hold — the aborted
			// tail is persisted and derived before the reply.
			await settleRecoveryRun();
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

		async setLabel(entryId: string, label: string) {
			// Mutation lock, same rationale as navigate: the append lands at the
			// session leaf, and interleaving a metadata entry with a pending turn
			// buys nothing — labels are never urgent. The client guards too, but
			// the daemon is the enforcement point for second tabs and raw RPC.
			if (document.status.isStreaming || document.status.isCompacting) {
				throw new Error("Cannot set a label while a turn is in flight");
			}
			sessionManager.appendLabelChange(entryId, label === "" ? undefined : label);
			// appendLabelChange appends to the session file without an
			// AgentSessionEvent, so reconcile from the file is what publishes the
			// entry to the Document — and through the patch, to every connection.
			tryReconcile({});
		},

		async navigate(entryId: string | null) {
			// Server-side mutation lock: branching swaps the LLM context under the
			// running turn (agent.state.messages is rebuilt below), so a navigate
			// during an in-flight turn or compaction would corrupt the run. The
			// client disables this path, but the daemon is the enforcement point —
			// a second tab or raw RPC must not fork mid-turn either.
			if (document.status.isStreaming || document.status.isCompacting) {
				throw new Error("Cannot navigate while a turn is in flight");
			}
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
			publishLeaf(entryId);
		},

		async recoverTurn(): Promise<"retry" | "continue"> {
			// Same mutation lock as navigate: recovery branches (swapping the LLM
			// context) and then starts a run.
			if (document.status.isStreaming || document.status.isCompacting) {
				throw new Error("Cannot recover while a turn is in flight");
			}
			const info = computeRecoverableTurn(document);
			if (!info) {
				throw new Error("No failed or interrupted turn to recover");
			}
			const repair = RECOVERY_REPAIRS[info.kind];
			// The relay must be built from the pre-branch leaf path: the dangling
			// assistant and its completed results leave the path when recovery
			// branches past them, and the relay carries bounded copies of exactly
			// those. ("Continue." is the interruptedTools fallback for the
			// killed-mid-run shape, whose results stay on the path.)
			const relay = repair.restart === "prompt" ? buildInterruptedToolsRelay(document, info) : "Continue.";

			// Branch past the dead entry — the navigate verb's exact machinery —
			// except unfinishedTurn, whose tail is already a valid continuation
			// boundary (fully-answered tool results, no final assistant), so the
			// run is simply continued from where it stopped.
			if (repair.branch) {
				const target = document.entries[info.entryId];
				if (!target || target.parentId === null) {
					throw new Error("Recovery target has no parent to branch to");
				}
				sessionManager.branch(target.parentId);
				// Intentional coupling to pi internals (same as navigate): the
				// abandoned tail must leave agent.state.messages before the
				// continued run sends its context to the LLM.
				session.agent.state.messages = sessionManager.buildSessionContext().messages;
				publishLeaf(target.parentId);
			}

			// interruptedTools: a visible relay through AgentSession's normal
			// machinery (retry, overflow recovery, steering, settle events). It
			// preserves completed results and marks calls with unknown outcomes;
			// records are bounded and treated as untrusted data.
			if (repair.restart === "prompt") {
				await session.prompt(relay, {
					source: "rpc",
					streamingBehavior: "steer",
					preflightResult: () => {},
				});
				return "continue";
			}

			// failedTurn/unfinishedTurn: the silent re-request. agent.continue()
			// runs outside pi's _runAgentPrompt wrapper (its only public
			// continuation entry), so this run gets no auto-retry/overflow
			// handling and fires no agent_settled — the event the Document's
			// isStreaming reset and the settle reconcile key on. The run is
			// tracked (abort/dispose await it via the Manager), and the finally
			// compensates on every exit path (success, error, abort); the
			// missing retry loop is an accepted limitation (ADR 16).
			const run = session.agent.continue();
			recoveryRun = run;
			try {
				await run;
			} finally {
				recoveryRun = null;
				const ops: PatchOp[] = [];
				if (document.status.isStreaming) {
					document = setAtPath(document, "/status/isStreaming", false);
					ops.push({ op: "replace", path: "/status/isStreaming", value: false });
				}
				if (ops.length > 0) emitPatch({ ops });
				const recPatch = boundaryReconcile(true);
				if (recPatch) emitPatch(recPatch);
				for (const l of settledListeners) l();
			}
			return "retry";
		},

		async dispose() {
			// 1. Save: finalize + flush the in-flight turn — including a recovery
			//    continuation, which session.abort()'s idle-wait cannot see
			//    (ADR 16). Listeners are still attached, so client tabs see the
			//    final patches before teardown.
			await session.abort();
			await settleRecoveryRun();
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
