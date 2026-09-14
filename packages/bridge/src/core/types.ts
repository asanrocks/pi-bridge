// ============================================================================
// Wire-safe types for the bridge data model (ADR 02 + ADR 06)
// ============================================================================

// ---------------------------------------------------------------------------
// JSON value (for projection of `unknown` fields from SessionEntry)
// ---------------------------------------------------------------------------
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Content blocks (wire-safe projections)
// ---------------------------------------------------------------------------
export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string;
}

export interface ThinkingContent {
	type: "thinking";
	/** null when lazy (not pulled). */
	thinking: string | null;
	thinkingSignature?: string;
	redacted?: boolean;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	/** null when lazy (not pulled). Partial object during streaming. */
	arguments: JsonValue | null;
	thoughtSignature?: string;
}

export type Content = TextContent | ThinkingContent | ImageContent | ToolCallBlock;

// ---------------------------------------------------------------------------
// Usage / cost (subset of pi-ai Usage)
// ---------------------------------------------------------------------------
export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

// ---------------------------------------------------------------------------
// Entry union (wire-safe projection of SessionEntry)
// ---------------------------------------------------------------------------
export interface EntryBase {
	id: string; // provisional ("pending:...") until seal
	parentId: string | null; // set at seal for streamed entries
	timestamp: string; // set at seal for streamed entries
	/**
	 * Zero-based index in SessionManager.getEntries() (ADR 09). Assigned only
	 * where the full file-ordered list is in hand (initFromEntries, reconcile,
	 * initial sync) — never by applyEvent. Absent on provisional entries and
	 * on entry_appended entries until the next reconcile assigns it. Once
	 * assigned for a logical session it does not change.
	 */
	ord?: number;
}

export interface MessageEntry extends EntryBase {
	kind: "message";
	role: "user" | "assistant";
	content: Content[];
	// assistant-only fields. Optional metadata is normalized to `null` when
	// absent (never `undefined`) so the streaming skeleton, the file
	// projection, and cache records all produce one deterministic shape.
	api?: string;
	provider?: string;
	model?: string;
	responseModel?: string | null;
	responseId?: string | null;
	usage?: Usage;
	stopReason?: string;
	errorMessage?: string | null;
}

export interface ToolResultEntry extends EntryBase {
	kind: "tool_result";
	toolCallId: string;
	toolName: string;
	/** null when lazy (not pulled). */
	content: Content[] | null;
	/** null when lazy (not pulled). Projected to JsonValue. */
	details: JsonValue | null;
	isError: boolean;
}

export interface CompactionEntry extends EntryBase {
	kind: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details: JsonValue | null;
	fromHook: boolean;
}

export interface BranchSummaryEntry extends EntryBase {
	kind: "branch_summary";
	fromId: string;
	summary: string;
	details: JsonValue | null;
	fromHook: boolean;
}

export interface ModelChangeEntry extends EntryBase {
	kind: "model_change";
	provider: string;
	modelId: string;
}

export interface ThinkingLevelChangeEntry extends EntryBase {
	kind: "thinking_level_change";
	thinkingLevel: string;
}

export interface LabelEntry extends EntryBase {
	kind: "label";
	targetId: string;
	label: string | undefined;
}

export interface SessionInfoEntry extends EntryBase {
	kind: "session_info";
	name: string | undefined;
}

export interface CustomEntry extends EntryBase {
	kind: "custom";
	customType: string;
	data: JsonValue | null;
}

export interface CustomMessageEntry extends EntryBase {
	kind: "custom_message";
	customType: string;
	content: Content[] | null;
	details: JsonValue | null;
	display: boolean;
}

export interface BashExecutionEntry extends EntryBase {
	kind: "bash_execution";
	/** The command the user ran (the `!` / `!!` composer prefix). */
	command: string;
	/** Full output, wire-eager (bounded by the executor's truncation). */
	output: string;
	/** null when the process was killed without an exit code. */
	exitCode: number | null;
	cancelled: boolean;
	truncated: boolean;
	/** Temp file holding the full output when truncated. */
	fullOutputPath: string | null;
	/** `!!` runs are excluded from the LLM context; the card renders muted. */
	excludeFromContext: boolean;
}

export type Entry =
	| MessageEntry
	| ToolResultEntry
	| BashExecutionEntry
	| CompactionEntry
	| BranchSummaryEntry
	| ModelChangeEntry
	| ThinkingLevelChangeEntry
	| LabelEntry
	| SessionInfoEntry
	| CustomEntry
	| CustomMessageEntry;

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
export interface Stats {
	tokens: {
		input: number;
		output: number;
		total: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
	cost: { total: number };
	messages: number;
}

export interface ContextUsage {
	/** Estimated context tokens, or null if unknown (e.g. right after compaction, before next LLM response). */
	tokens: number | null;
	contextWindow: number;
	/** Context usage as percentage of context window, or null if tokens is unknown. */
	percent: number | null;
}

export interface Status {
	leafId: string | null;
	name: string;
	/** Active model identity (provider + modelId). Empty pair {"",""} = no model. */
	model: ModelRef;
	thinkingLevel: string;
	isStreaming: boolean;
	isCompacting: boolean;
	stats: Stats;
	/** Context window usage, synced from AgentSession.getContextUsage(). null when unknown (post-compaction, no response yet). */
	contextUsage: ContextUsage | null;
	/** Pending steer messages queued during streaming (AgentSession queue_update). FIFO; drained as subsequent user turns. Wire-eager — not a lazy field. */
	pendingSteer: string[];
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------
export interface Document {
	status: Status;
	/** All entries, committed (immutable) + in-flight (provisional id). */
	entries: Record<string, Entry>;
	/** Curated list of models from the session's scopedModels (--models flag / settings). */
	scopedModels: ScopedModelInfo[];
}

// ---------------------------------------------------------------------------
// Patch / operations
// ---------------------------------------------------------------------------
export interface AddOp {
	op: "add";
	path: string;
	value: JsonValue;
}

export interface RemoveOp {
	op: "remove";
	path: string;
}

export interface ReplaceOp {
	op: "replace";
	path: string;
	value: JsonValue;
}

export interface MoveOp {
	op: "move";
	from: string;
	path: string;
}

export interface AppendOp {
	op: "append";
	path: string;
	value: string;
}

export type PatchOp = AddOp | RemoveOp | ReplaceOp | MoveOp | AppendOp;

export interface Patch {
	ops: PatchOp[];
}

// ---------------------------------------------------------------------------
// Wire protocol messages (ADR 06: dual channel)
// ---------------------------------------------------------------------------

// ── Push (server → client, no `id`) ──────────────────────────────────────

export interface ReplaceMessage {
	kind: "replace";
	/** Durable session id. Present on initial-sync pushes only (ADR 09); live patches do not repeat it. */
	sessionId?: string;
	document: Document;
}

export interface PatchMessage {
	kind: "patch";
	/** Durable session id. Present on the initial-sync delta push only (ADR 09). */
	sessionId?: string;
	ops: PatchOp[];
}

export interface SessionsChangedMessage {
	kind: "sessions_changed";
	sessions: SessionInfo[];
	hasMore: boolean;
}

export interface InstanceExitMessage {
	kind: "instance_exit";
	instanceId: string;
}

export type ServerPushMessage = ReplaceMessage | PatchMessage | SessionsChangedMessage | InstanceExitMessage;

// ── RPC (client → server, with `id`) ─────────────────────────────────────

/** Client→server RPC call. `verb` selects the handler. */
export interface RpcRequest {
	id: string;
	verb: string;
	// Verb-specific payload fields
	[key: string]: JsonValue;
}

/** Server→client RPC reply — same id as the request. */
export interface RpcReply {
	id: string;
	ok: boolean;
	// Verb-specific result fields (ok: true) or error (ok: false)
	[key: string]: JsonValue;
}

// ── Union types ──────────────────────────────────────────────────────────

export type ServerMessage = ServerPushMessage | RpcReply;

export type ClientMessage = RpcRequest;

// ---------------------------------------------------------------------------
// Verb-specific RPC payload shapes (typed, for BridgeClient)
// ---------------------------------------------------------------------------

/** Max image attachments per prompt (wire limit, enforced host-side). */
export const MAX_IMAGES_PER_MESSAGE = 5;

/** Max base64 string length per image attachment (wire limit, enforced host-side). */
export const MAX_IMAGE_BASE64_LENGTH = 4.5 * 1024 * 1024;

export interface PromptRequest {
	verb: "prompt";
	text: string;
	/** Optional image attachments (base64 + mimeType), sent as part of the user message. */
	images?: ImageContent[];
}

export interface AbortRequest {
	verb: "abort";
}

/** Clear all pending steer/follow-up messages from the session queue. */
export interface DiscardSteerRequest {
	verb: "discardSteer";
}

export interface SetModelRequest {
	verb: "setModel";
	provider: string;
	model: string;
}

export interface SetThinkingLevelRequest {
	verb: "setThinkingLevel";
	level: string;
}

export interface RenameSessionRequest {
	verb: "renameSession";
	name: string;
}

export interface NavigateRequest {
	verb: "navigate";
	entryId: string | null;
}

export interface SwitchSessionRequest {
	verb: "switchSession";
	/** Session file path to resume. Not a session id — live sessions have no file yet. */
	sessionPath: string;
	/** Optional client cache prefix cursor (ADR 09). */
	cursor?: PrefixCursor;
}

export interface NewSessionRequest {
	verb: "newSession";
}

export interface ListSessionsRequest {
	verb: "listSessions";
	ts?: string | null;
	max?: number | null;
}

export interface GetDaemonInfoRequest {
	verb: "getDaemonInfo";
}

export interface PullRequest {
	verb: "pull";
	requests: { entryId: string; fieldPath: string }[];
}

export interface ListFilesRequest {
	verb: "listFiles";
	prefix: string;
}

export interface ConsoleRequest {
	verb: "console";
	level: "log" | "warn" | "error";
	args: JsonValue[];
}

// ── Instance routing verb request shapes ──────────────────────────────

/** Client cache prefix cursor (ADR 09). Identifies the committed entry
 * prefix a client already holds, so initial sync can send only the suffix. */
export interface PrefixCursor {
	sessionId: string;
	/** Entry id at ord = entryCount - 1 (the prefix anchor). */
	lastKnownId: string;
	/** Number of contiguous cached entries (ords 0..entryCount-1). */
	entryCount: number;
}

export interface SwitchInstanceRequest {
	verb: "switchInstance";
	instanceId: string;
	/** Optional client cache prefix cursor (ADR 09). */
	cursor?: PrefixCursor;
}

export interface NewInstanceRequest {
	verb: "newInstance";
	cwd: string;
}

export interface KillInstanceRequest {
	verb: "killInstance";
	instanceId: string;
}

export interface ListInstancesRequest {
	verb: "listInstances";
}

/** Detach the connection from its instance (client returned to the instance
 * list). Connection-local: unbinds without touching the registry. */
export interface DetachInstanceRequest {
	verb: "detachInstance";
}

/** Union of all RPC request shapes (for type-safe verb methods). */
export type RpcRequestBody =
	| PromptRequest
	| AbortRequest
	| DiscardSteerRequest
	| SetModelRequest
	| SetThinkingLevelRequest
	| RenameSessionRequest
	| NavigateRequest
	| SwitchSessionRequest
	| NewSessionRequest
	| ListSessionsRequest
	| GetDaemonInfoRequest
	| PullRequest
	| ListFilesRequest
	| ConsoleRequest
	| SwitchInstanceRequest
	| NewInstanceRequest
	| KillInstanceRequest
	| ListInstancesRequest
	| DetachInstanceRequest;

// ── Verb-specific reply shapes ───────────────────────────────────────────

export interface SessionInfo {
	/** Durable session id from the session file header (ADR 09). Cache key. */
	sessionId: string;
	/** Session file path, or null for a live session with no file on disk yet. */
	sessionPath: string | null;
	name?: string;
	timestamp: string;
	firstMessageText?: string;
	messageCount?: number;
}

/** Info about a running instance (Manager), for listInstances reply. */
export interface InstanceInfo {
	/** Stable id assigned by the Daemon at instance creation. */
	instanceId: string;
	/** The instance's current session id (from SessionManager). */
	sessionId: string;
	/** The instance cwd. */
	cwd: string;
	/** Session name (from document.status.name). */
	name: string;
	/** Whether the instance's session is streaming. */
	isStreaming: boolean;
	/** ISO timestamp of the most recent entry (last activity). Omitted when the session has no sealed entries yet. */
	lastActivityAt?: string;
	/** Most recent message text (any role), clamped to one line. Omitted when no message with text exists yet. */
	preview?: string;
	/** Message count from session stats. */
	messageCount?: number;
}

export interface ListSessionsReply {
	id: string;
	ok: true;
	sessions: SessionInfo[];
	hasMore?: boolean;
}

export interface ScopedModelInfo {
	provider: string;
	id: string;
	name: string;
	thinkingLevel?: string;
}

export interface ModelInfo {
	provider: string;
	/** Provider display name from pi's Provider registry (e.g. "DeepSeek").
	 * Absent when the daemon can't resolve the provider (e.g. it was
	 * configured at session time but is no longer available). */
	providerName?: string;
	id: string;
	name: string;
	reasoning: boolean;
	/** Thinking levels accepted by this model, including "off". */
	supportedThinkingLevels?: string[];
	contextWindow?: number;
}

/**
 * Identity pair for the active model. Carries provider alongside modelId so
 * same-id models offered by multiple providers (e.g. "claude-sonnet-4-5" under
 * both Anthropic and an OpenRouter-compatible provider) stay disambiguated.
 * Mirrors the { provider, modelId } shape of ModelChangeEntry, which is the
 * entry deriveModel projects from.
 */
export interface ModelRef {
	provider: string;
	modelId: string;
}

export interface GetDaemonInfoReply {
	id: string;
	ok: true;
	models: ModelInfo[];
	thinkingLevels: string[];
	cwdAllowlist: string[];
	devMode: boolean;
}

export interface PullReply {
	id: string;
	ok: true;
	values: { entryId: string; fieldPath: string; value: JsonValue }[];
}

export interface ListFilesReply {
	id: string;
	ok: true;
	entries: Array<{ path: string; isDirectory: boolean }>;
}

export interface ListInstancesReply {
	id: string;
	ok: true;
	instances: InstanceInfo[];
}

export interface NewInstanceReply {
	id: string;
	ok: true;
	instanceId: string;
}

export interface VerbReply {
	id: string;
	ok: boolean;
	error?: string;
}

// ---------------------------------------------------------------------------
// Lazy field paths — used by filterPatchForSocket
// ---------------------------------------------------------------------------
/**
 * Pattern: `/entries/<id>/content/<i>/thinking`
 * Pattern: `/entries/<id>/content/<i>/arguments`
 * Pattern: `/entries/<id>/content`              (tool result)
 * Pattern: `/entries/<id>/details`              (tool result)
 */
export const LAZY_FIELD_PATTERNS: RegExp[] = [
	/^\/entries\/[^/]+\/content\/\d+\/thinking$/,
	/^\/entries\/[^/]+\/content\/\d+\/arguments$/,
	/^\/entries\/[^/]+\/content$/,
	/^\/entries\/[^/]+\/details$/,
];

/**
 * Patterns for lazy fields whose sub-paths are also lazy.
 * These are object-valued fields (arguments, details) where individual keys
 * are patched granularly. Leaf-string fields like thinking are excluded.
 */
const LAZY_OBJECT_PATTERNS: RegExp[] = [
	/^\/entries\/[^/]+\/content\/\d+\/arguments$/, // ToolCall arguments
	/^\/entries\/[^/]+\/details$/, // ToolResult details
];

/** Returns true if the given patch path is a lazy content-bearing field.
 * Sub-paths of lazy object fields (e.g. /arguments/path, /arguments/nested/key)
 * are also treated as lazy — they are gated by the same subscription. */
export function isLazyFieldPath(path: string): boolean {
	if (LAZY_FIELD_PATTERNS.some((p) => p.test(path))) return true;
	// For object-valued lazy fields, sub-paths at any depth are lazy.
	// Walk up ancestors until we find a lazy object root.
	let parent: string = path;
	while (parent.includes("/")) {
		parent = parent.replace(/\/[^/]+$/, "");
		if (LAZY_OBJECT_PATTERNS.some((p) => p.test(parent))) return true;
	}
	return false;
}
