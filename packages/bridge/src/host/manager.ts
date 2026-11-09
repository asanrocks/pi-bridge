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
	applyPatch,
	buildInitialSync,
	type ContextUsage,
	computeRecoverableTurn,
	createEntryProjection,
	type Document,
	GIT_STAMP_CUSTOM_TYPE,
	type ImageContent,
	type InitialSyncFrame,
	initFromEntries,
	type JsonValue,
	type ModelRef,
	type Patch,
	type PatchOp,
	type PrefixCursor,
	type RecoverableTurnKind,
	type SessionRef,
	setAtPath,
} from "../core/index.ts";
import { buildInterruptedToolsRelay } from "../core/recovery.ts";
import { createGitStampExtensionWithTrigger, type GitStampDeps, type GitStampTrigger } from "./git-stamp-extension.ts";
import { resolveActivity, type SessionActivity, type SessionPhase } from "./process-title.ts";

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
	/** Overrides for the git-stamp observation deps (runner, timeout). Test
	 * seam: a gated runner reproduces a slow git under load without one on
	 * PATH. */
	gitStampDeps?: Partial<GitStampDeps>;
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
	onInitialSync(frame: InitialSyncFrame): void;
}

/** Which settle a Manager reports: the end of one pi turn (an assistant step,
 * with the tool results it produced) or of the whole execution. One tagged
 * value rather than a boolean, because each listener acts on one of the two. */
export type SettlementBoundary = "turn" | "execution";

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
	 * Register a listener for session-settled events. The first such event on a
	 * new session triggers the deferred file write, so listeners can rescan
	 * sessions to pick up the now-on-disk metadata.
	 *
	 * The boundary is the tag the listener needs to tell the two apart: pi emits
	 * `turn_end` after every assistant step — a tool-using turn has one per tool
	 * batch — and `agent_settled` once, when the whole run is over. Metadata
	 * refreshes want both; a completion notification wants only the execution
	 * (ADR 24). Returns unsubscribe function.
	 */
	onSettled(listener: (boundary: SettlementBoundary) => void): () => void;
	/**
	 * What this Session is doing right now, as pi's event stream reports it.
	 * Derived from the events themselves rather than from the projection: the
	 * process title needs one word, and building a ViewModel per delta for it
	 * would cost more than the title is worth.
	 */
	activity(): SessionActivity;
	/** Register a listener for real activity transitions (deduped here, so one
	 * turn's token stream is a handful of calls). Returns unsubscribe. */
	onActivityChange(listener: () => void): () => void;

	// ── Session verbs ─────────────────────────────────────────────────────

	/** Send a user message and await the whole turn. The optional carries are
	 * the stateless client API's selection: applied to pi's session before the
	 * turn (see the implementation) and recorded on the path, so the next
	 * send's inheritance and a cold resume agree with what ran. */
	prompt(text: string, images?: ImageContent[], model?: ModelRef, thinkingLevel?: string): Promise<void>;
	/** Admit a prompt without awaiting the turn: resolves once pi's preflight
	 * accepts it (model/auth validated, message enqueued — the turn runs on in
	 * the background), rejects if admission fails. A rejection *after*
	 * admission never surfaces here; it becomes document state. This is the
	 * wire `prompt` verb's path (ADR 12 Reply semantics) and the first prompt of
	 * the text-bearing `newSession` (ADR 12 slice). */
	promptAdmitted(text: string, images?: ImageContent[], model?: ModelRef, thinkingLevel?: string): Promise<void>;
	/** Run a user `!` command in the instance cwd. Recorded as a
	 * `bashExecution` entry — also an ADR 10 user_bash_end observation
	 * boundary. */
	executeBash(command: string, options?: { excludeFromContext?: boolean }): Promise<void>;
	abort(): Promise<void>;
	/** Clear all pending steer/follow-up messages from the session queue. */
	discardSteer(): Promise<void>;
	/** Apply a model selection to pi's session (recorded as a `model_change`,
	 * level re-derived by pi for the switch). Not a wire verb: the prompt
	 * carries and `newSession`'s pre-session choices are the callers. */
	setModel(provider: string, modelId: string): Promise<void>;
	/** Apply a thinking level (clamped by pi; recorded only on change). Not a
	 * wire verb: the prompt carries and `newSession` are the callers. */
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

	/** Finalize and tear down: the in-flight turn settles (client tabs see
	 * the final patches), the git-stamp observation scope stops admitting and
	 * drains (every admitted observation appends before the runtime goes),
	 * then the runtime is disposed. Idempotent and joinable: every caller
	 * observes the same teardown. */
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
	const settledListeners = new Set<(boundary: SettlementBoundary) => void>();
	const activityListeners = new Set<() => void>();
	const connectionHandles = new Set<ConnectionHandle>();
	// ADR 10: one bundle per Manager. An activation serves exactly one session
	// for its lifetime (ADR 11), so the host trigger never rebinds.
	const gitStampBundle = createGitStampExtensionWithTrigger(options.gitStampDeps);

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
	// The name of each in-flight tool, by call id and in start order. Parallel
	// tool calls share one phase word, so an ending tool must not erase the name
	// of the sibling that is still running.
	const inFlightToolName = new Map<string, string>();
	/** The most recently started tool still in flight, or null. Insertion order
	 * is start order, so the last entry is the newest. */
	const latestRunningTool = (): string | null => {
		let name: string | null = null;
		for (const tool of inFlightToolName.values()) name = tool;
		return name;
	};
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

	// ── Live phase (see `activity()` below) ──
	//
	// pi reports the phase implicitly, through the shape of its events: a
	// thinking delta, a text delta, a tool call being written, a tool running.
	// This is the same story the browser's `liveActivityPhase` tells from the
	// projection; both start at pi's stream, and the title only needs the
	// coarse version.
	let phase: SessionPhase = "idle";
	let phaseTool: string | null = null;
	/** The tool the events last started, kept past the phase word so a settle
	 * that races a running tool cannot erase its name. */
	let activeTool: string | null = null;
	const setPhase = (next: SessionPhase, tool: string | null): void => {
		if (next === "tool" && tool !== null) activeTool = tool;
		if (next === "tool" && tool === null && phase !== "tool") activeTool = null;
		if (next === phase && tool === phaseTool) return;
		phase = next;
		phaseTool = tool;
		for (const l of activityListeners) l();
	};
	const trackActivity = (event: AgentSessionEvent): void => {
		switch (event.type) {
			case "agent_start":
			case "turn_start":
			case "message_start":
				setPhase("wait", null);
				break;
			case "message_update": {
				const delta = event.assistantMessageEvent.type;
				if (delta.startsWith("thinking")) setPhase("think", null);
				else if (delta.startsWith("text")) setPhase("stream", null);
				else if (delta.startsWith("toolcall")) setPhase("tool", null);
				break;
			}
			case "tool_execution_start":
				inFlightToolName.set(event.toolCallId, event.toolName);
				setPhase("tool", event.toolName);
				break;
			case "tool_execution_end": {
				// With a sibling still running the phase stays `tool` under that
				// tool's name; only the last tool ending returns the run to waiting
				// on the provider (not idle).
				inFlightToolName.delete(event.toolCallId);
				const remaining = latestRunningTool();
				activeTool = remaining;
				setPhase(remaining === null ? "wait" : "tool", remaining);
				break;
			}
			case "compaction_start":
				setPhase("compact", null);
				break;
			case "compaction_end":
				setPhase("wait", null);
				break;
			case "auto_retry_start":
				setPhase("retry", null);
				break;
			case "auto_retry_end":
				setPhase("wait", null);
				break;
			case "turn_end":
			case "agent_end":
				setPhase("wait", null);
				break;
			case "agent_settled":
				setPhase("idle", null);
				break;
			default:
				break;
		}
	};

	const processEvent = (event: AgentSessionEvent) => {
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

		// The live half: create or update the form of the item in flight. The
		// persistent half is discovered below from pi's entry list, so an event
		// payload is never treated as proof that an entry exists.
		const livePatch = projection.applyEvent(event);
		{
			// The projection already applied its ops to the canonical Document.
			const ops = [...(livePatch?.ops ?? []), ...inFlightOps];
			if (inFlightOps.length > 0) state.document = applyPatch(state.document, inFlightOps);
			// After this event's Document state, so a listener reading `activity()`
			// sees the phase and the liveness anchors it is reconciled against
			// (`isStreaming`, `inFlightTools`) agree with each other.
			trackActivity(event);
			// Emit before the boundary refresh runs: a later patch mutates the
			// canonical Document, and a mirror that received this one only must
			// still match it at this point.
			if (ops.length > 0) emitPatch({ ops });
		}
		// Read pi's entry list now: a refresh that finds nothing new is O(live
		// forms), and the Document and its patches stay in lockstep per event.
		refresh();

		if (event.type === "turn_end" || event.type === "agent_settled") {
			const execution = event.type === "agent_settled";
			const recPatch = boundaryReconcile(execution);
			if (recPatch) emitPatch(recPatch);
			// Notify connections that the session has settled — the first turn
			// after newSession writes the session file, and listeners can rescan
			// to pick up the now-on-disk metadata (name, message count, etc.).
			for (const l of settledListeners) l(execution ? "execution" : "turn");
		}

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

	// Bootstrap the canonical Document from pi's entry list. The projection owns
	// every later merge of live forms and persisted entries.
	const state: { document: Document } = { document: initFromEntries([]) };
	const projection = createEntryProjection(state);
	projection.refresh(sessionManager.readEntries(0));
	if (session.model) {
		state.document = setAtPath(state.document, "/status/model", {
			provider: session.model.provider,
			modelId: session.model.id,
		} as unknown as JsonValue);
	}
	state.document = setAtPath(state.document, "/status/thinkingLevel", session.thinkingLevel);
	// Sync initial context usage into the document (no listeners subscribed yet
	// during bootstrap, so this doesn't emit a patch). The first `replace` push
	// sent by addConnection will include the value.
	{
		const cu = getContextUsageOption(session);
		if (cu !== undefined) {
			state.document = setAtPath(state.document, "/status/contextUsage", cu as unknown as JsonValue);
		}
	}
	// ADR 16: a resumed session can carry a broken tail (terminal error or
	// dangling tool calls) — the first replace a client receives already
	// carries the recovery kind, so the affordance is there on first paint.
	state.document = setAtPath(
		state.document,
		"/status/recoverableTurn",
		computeRecoverableTurn(state.document)?.kind ?? null,
	);

	// Subscribe to pi events
	unsubscribe = session.subscribe(processEvent);

	// ADR 16: the recovery kind of the current leaf path's tail. Recomputed at
	// every idle boundary (settle, tryReconcile), on navigate, and at boot.
	const recoverableTurnKindOf = (doc: Document): RecoverableTurnKind | null =>
		computeRecoverableTurn(doc)?.kind ?? null;

	/**
	 * Bring the Document up to date with pi's entry list and live status.
	 *
	 * This is the single publication boundary. Events, idle verbs, and attach
	 * all funnel here, so a consumer never sees a child before its parent nor an
	 * entry that only an event payload claimed exists. `settle` is for a boundary
	 * where pi proves no further persistence will happen: live forms without an
	 * entry are then dropped. A recovery continuation (ADR 16) runs outside pi's
	 * settle events while the Document reports idle, so its live forms survive
	 * until the continuation's own compensated end drops them.
	 *
	 * Context usage is sampled only where it can move — settle boundaries and
	 * attach — because pi derives it from a full session projection and the
	 * per-event refresh runs at token cadence.
	 */
	const refresh = (options: { settle?: boolean; emit?: boolean; usage?: boolean } = {}): Patch | null => {
		const ops: PatchOp[] = [];
		const settling = options.settle === true && recoveryRun === null;
		if (settling) {
			const settled = projection.settle();
			if (settled) ops.push(...settled.ops);
		}
		const refreshed = projection.refreshFrom((from) => sessionManager.readEntries(from));
		if (refreshed) ops.push(...refreshed.ops);

		// Status fields the entry list cannot supply.
		const modelRef = session?.model ? { provider: session.model.provider, modelId: session.model.id } : undefined;
		if (modelRef) {
			const current = state.document.status.model;
			if (current.provider !== modelRef.provider || current.modelId !== modelRef.modelId) {
				state.document = setAtPath(state.document, "/status/model", modelRef as unknown as JsonValue);
				ops.push({ op: "replace", path: "/status/model", value: modelRef as unknown as JsonValue });
			}
		}
		if (session) {
			const level = session.thinkingLevel;
			if (state.document.status.thinkingLevel !== level) {
				state.document = setAtPath(state.document, "/status/thinkingLevel", level);
				ops.push({ op: "replace", path: "/status/thinkingLevel", value: level });
			}
		}
		if (options.settle === true || options.usage === true) {
			const cu = getContextUsageOption(session);
			if (cu !== undefined && JSON.stringify(cu) !== JSON.stringify(state.document.status.contextUsage)) {
				state.document = setAtPath(state.document, "/status/contextUsage", cu as unknown as JsonValue);
				ops.push({ op: "replace", path: "/status/contextUsage", value: cu as unknown as JsonValue });
			}
		}
		if (settling) {
			const kind = recoverableTurnKindOf(state.document);
			if ((state.document.status.recoverableTurn ?? null) !== kind) {
				state.document = setAtPath(state.document, "/status/recoverableTurn", kind);
				ops.push({ op: "replace", path: "/status/recoverableTurn", value: kind as unknown as JsonValue });
			}
		}

		if (ops.length === 0) return null;
		const patch: Patch = { ops };
		if (options.emit !== false) emitPatch(patch);
		return patch;
	};

	/** Turn-boundary refresh shared by the event path and the recovery
	 * continuation's compensation (ADR 16). Drops live forms that will never
	 * persist and re-derives the recovery kind. */
	const boundaryReconcile = (settle: boolean): Patch | null => refresh({ settle, emit: false });

	// ADR 16: an in-flight recovery continuation (agent.continue(), which runs
	// outside pi's _runAgentPrompt wrapper). AgentSession.isStreaming stays
	// false while it runs, so session.abort()'s idle-wait does not cover it —
	// the Manager tracks the run itself, and abort/dispose await it before
	// treating the session as settled.
	let recoveryRun: Promise<void> | null = null;
	// The memoized teardown (see dispose): null until the first call.
	let disposed: Promise<void> | null = null;
	const settleRecoveryRun = async (): Promise<void> => {
		if (recoveryRun) await recoveryRun.catch(() => {});
	};

	/** Idle boundary: install silent entries (labels, extension entries) and
	 * refresh status. Refused mid-run, where the event path owns publication. */
	function tryReconcile(): void {
		if (state.document.status.isStreaming || state.document.status.isCompacting) return;
		refresh({ settle: true });
	}

	/** The stateless client API's worker-side adapter: a send carries its
	 * selection, and this is where the carry meets pi's stateful session.
	 * Applied before the turn so the whole run (retries, continuations after
	 * tool results) uses it, and recorded on the path so a cold resume — the
	 * terminal client included — restores the same model. Only while idle: a
	 * queued steer keeps the running model, because a mid-turn swap would change
	 * the model under the in-flight run. An omitted carry leaves the session's
	 * current selection in force (the last applied one — the fallback
	 * unattended runs use too).
	 */
	async function applySelection(model?: ModelRef, thinkingLevel?: string): Promise<void> {
		if (model === undefined && thinkingLevel === undefined) return;
		const busy = state.document.status.isStreaming || state.document.status.isCompacting;
		if (busy) return;
		const same =
			model !== undefined &&
			session.model !== undefined &&
			session.model.provider === model.provider &&
			session.model.id === model.modelId;
		if (model !== undefined && !same) await mgr.setModel(model.provider, model.modelId);
		if (thinkingLevel !== undefined) await mgr.setThinkingLevel(thinkingLevel);
	}

	// ── Manager object ────────────────────────────────────────────────────

	const mgr: Manager = {
		get document() {
			return state.document;
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
			// Refresh the in-flight anchors so a (re)connecting client recovers the
			// elapsed of tools already running. Not emitted as a patch: live clients
			// tick from their own local anchor, and only the fresh snapshot needs it.
			if (inFlightStart.size > 0) {
				state.document = applyPatch(state.document, [
					{ op: "replace", path: "/status/inFlightTools", value: inFlightElapsed() },
				]);
			}
			// Attach is a publication boundary. Refresh first, sampling context
			// usage for the frame, and publish what the refresh discovers to the
			// clients already attached: their mirrors must not miss entries the
			// refresh consumes, and the read position advances with it — a later
			// refresh would never resend them. The new connection is registered
			// after, so it receives the same state once, as its initial sync,
			// before any later live patch (ADR 09 invariant 7).
			refresh({ usage: true });
			connectionHandles.add(handle);
			handle.onInitialSync(buildInitialSync(state.document, sessionManager.getEntries(), sessionRef, cursor));
		},
		removeConnection(handle) {
			connectionHandles.delete(handle);
		},
		onSettled(listener) {
			settledListeners.add(listener);
			return () => settledListeners.delete(listener);
		},
		activity() {
			const status = state.document.status;
			return resolveActivity({
				phase,
				tool: activeTool ?? phaseTool,
				streaming: status.isStreaming,
				compacting: status.isCompacting,
				toolRunning: inFlightStart.size > 0,
				recoverable: (status.recoverableTurn ?? null) !== null,
			});
		},
		onActivityChange(listener) {
			activityListeners.add(listener);
			return () => activityListeners.delete(listener);
		},

		async prompt(text: string, images?: ImageContent[], model?: ModelRef, thinkingLevel?: string) {
			await applySelection(model, thinkingLevel);
			await session.prompt(text, {
				source: "rpc",
				streamingBehavior: "steer",
				preflightResult: () => {},
				...(images && images.length > 0 ? { images } : {}),
			});
		},

		async promptAdmitted(text: string, images?: ImageContent[], model?: ModelRef, thinkingLevel?: string) {
			// Carries are applied before admission too: a reply that lands at
			// preflight must already describe the selection the run will use.
			await applySelection(model, thinkingLevel);
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
							// A failure after admission is document state: the turn ran and
							// its outcome settles through the event stream.
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
			tryReconcile();
		},

		async setThinkingLevel(level: string) {
			session.setThinkingLevel(level as ThinkingLevel);
			tryReconcile();
		},

		async renameSession(name: string) {
			await session.setSessionName(name);
		},

		async setLabel(entryId: string, label: string) {
			// Mutation lock, same rationale as navigate: the append lands at the
			// session leaf, and interleaving a metadata entry with a pending turn
			// buys nothing — labels are never urgent. The client guards too, but
			// the daemon is the enforcement point for second tabs and raw RPC.
			if (state.document.status.isStreaming || state.document.status.isCompacting) {
				throw new Error("Cannot set a label while a turn is in flight");
			}
			sessionManager.appendLabelChange(entryId, label === "" ? undefined : label);
			// appendLabelChange appends without an AgentSessionEvent. The refresh
			// reads it from the entry list, which is why a silent append needs no
			// notification of its own.
			tryReconcile();
		},

		async navigate(entryId: string | null) {
			// Server-side mutation lock: branching swaps the LLM context under the
			// running turn (agent.state.messages is rebuilt below), so a navigate
			// during an in-flight turn or compaction would corrupt the run. The
			// client disables this path, but the daemon is the enforcement point —
			// a second tab or raw RPC must not fork mid-turn either.
			if (state.document.status.isStreaming || state.document.status.isCompacting) {
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
			// The projection owns the leaf: read pi's post-branch state back so
			// the leaf, the branch statistics, and the recovery kind all describe
			// the selected branch — publishing the leaf alone left the previous
			// branch's totals in place.
			tryReconcile();
		},

		async recoverTurn(): Promise<"retry" | "continue"> {
			// Same mutation lock as navigate: recovery branches (swapping the LLM
			// context) and then starts a run.
			if (state.document.status.isStreaming || state.document.status.isCompacting) {
				throw new Error("Cannot recover while a turn is in flight");
			}
			const info = computeRecoverableTurn(state.document);
			if (!info) {
				throw new Error("No failed or interrupted turn to recover");
			}
			const repair = RECOVERY_REPAIRS[info.kind];
			// The relay must be built from the pre-branch leaf path: the dangling
			// assistant and its completed results leave the path when recovery
			// branches past them, and the relay carries bounded copies of exactly
			// those. ("Continue." is the interruptedTools fallback for the
			// killed-mid-run shape, whose results stay on the path.)
			const relay = repair.restart === "prompt" ? buildInterruptedToolsRelay(state.document, info) : "Continue.";

			// Branch past the dead entry — the navigate verb's exact machinery —
			// except unfinishedTurn, whose tail is already a valid continuation
			// boundary (fully-answered tool results, no final assistant), so the
			// run is simply continued from where it stopped.
			if (repair.branch) {
				const target = state.document.entries[info.entryId];
				if (!target || target.parentId === null) {
					throw new Error("Recovery target has no parent to branch to");
				}
				sessionManager.branch(target.parentId);
				// Intentional coupling to pi internals (same as navigate): the
				// abandoned tail must leave agent.state.messages before the
				// continued run sends its context to the LLM.
				session.agent.state.messages = sessionManager.buildSessionContext().messages;
				// Same boundary as navigate: the projection re-reads pi's leaf and
				// re-derives what the new selection describes.
				tryReconcile();
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
			// isStreaming reset and the settle refresh key on. The run is
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
				if (state.document.status.isStreaming) {
					state.document = setAtPath(state.document, "/status/isStreaming", false);
					ops.push({ op: "replace", path: "/status/isStreaming", value: false });
				}
				if (ops.length > 0) emitPatch({ ops });
				const recPatch = boundaryReconcile(true);
				if (recPatch) emitPatch(recPatch);
				// The recovery run's own end is the execution boundary: its
				// continuation runs outside pi's turn loop (ADR 16).
				for (const l of settledListeners) l("execution");
			}
			return "retry";
		},

		dispose(): Promise<void> {
			// Idempotent and joinable: every caller observes the same teardown,
			// so a direct dispose (the harness) and the registry's Session actor
			// close cannot interleave a second run through it.
			if (disposed !== null) return disposed;
			disposed = (async () => {
				// 1. Save: finalize + flush the in-flight turn — including a
				//    recovery continuation, which session.abort()'s idle-wait
				//    cannot see (ADR 16). Listeners are still attached, so client
				//    tabs see the final patches before teardown. Turn boundaries
				//    may enqueue git-stamp observations; they are admitted before
				//    the scope closes and drained below.
				await session.abort();
				await settleRecoveryRun();
				// 2. Stop event-driven observations, then drain the observation
				//    scope BEFORE the runtime goes: every observation the
				//    finalization admitted is awaited here (its append lands on
				//    a live runtime), and the closed scope plus the removed
				//    subscription admit nothing afterwards — so no `git` spawn
				//    starts once teardown proceeds past this point, and no append
				//    reaches a runtime being torn down. A no-op when stamps were
				//    never bound.
				if (unsubscribe) {
					unsubscribe();
					unsubscribe = null;
				}
				await gitStampBundle.end();
				// 3. Tear down the pi runtime.
				await runtime.dispose();
			})();
			return disposed;
		},
	};

	return mgr;
}
