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
	/** `system` entries are pi's per-turn system-prompt diffs; the viewmodel
	 * ignores them (they are not conversation turns). */
	role: "user" | "assistant" | "system";
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
	/** Session reference (ADR 11). Always present: a replace is an initial sync. */
	session: SessionRef;
	document: Document;
}

export interface PatchMessage {
	kind: "patch";
	/**
	 * Present only for a cursor-aware initial-sync patch (ADR 09 + ADR 11).
	 * A patch without it is a live Document patch and carries no address.
	 */
	session?: SessionRef;
	ops: PatchOp[];
}

export interface SessionsChangedMessage {
	kind: "sessions_changed";
	projectId: string;
	/** First paginated page used to refresh that Project's session list. */
	sessions: SessionInfo[];
	hasMore: boolean;
	nextCursor?: SessionListCursor;
}

/** Global snapshot of active/streaming sessions across all Projects (ADR 11).
 * `SessionInfo.projectId` carries the Project identity. */
export interface ActiveSessionsChangedMessage {
	kind: "active_sessions_changed";
	sessions: SessionInfo[];
}

export type ServerPushMessage = ReplaceMessage | PatchMessage | SessionsChangedMessage | ActiveSessionsChangedMessage;

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

/** Resolve-or-activate a session by its address (ADR 11). If a live activation
 * for the session exists the Connection reattaches to it; otherwise one is
 * created from the session file. */
export interface OpenSessionRequest {
	verb: "openSession";
	projectId: string;
	stem: string;
	/** Optional client cache prefix cursor (ADR 09). */
	cursor?: PrefixCursor;
}

/** Create a new (initially unflushed) session in a Project (ADR 11). The
 * first prompt's `text` is required: it is admitted server-side before the
 * Connection attaches (an ADR 12 slice), so the initial sync the client
 * navigates into already carries the in-flight turn, and a refused prompt
 * disposes the fresh activation — no empty session is ever created. */
export interface NewSessionRequest {
	verb: "newSession";
	projectId: string;
	/** First prompt text. Required, non-empty. */
	text: string;
	/** Optional image attachments for the first prompt. */
	images?: ImageContent[];
	/** Optional model for the new session, applied before the prompt is
	 * admitted — the Project home's pre-session model choice. */
	model?: ModelRef;
	/** Optional thinking level, applied after the model (pi clamps to the
	 * model's supported levels). */
	thinkingLevel?: string;
}

/** Paginated history query for one Project (ADR 11). */
export interface ListSessionsRequest {
	verb: "listSessions";
	projectId: string;
	max?: number | null;
	cursor?: SessionListCursor | null;
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
	/** ADR 12: relative paths resolve against this Project's cwd, so path
	 * completion works before a session is attached (the Project home). */
	projectId: string;
}

/** Content-addressing for one repository snapshot: a pinned 40/64-hex object
 * id, "head" (resolved at query time), "index" (the staged tree), or
 * "worktree" (the live working tree). This is the one addressing vocabulary
 * for file content — the file viewer, the review diff's per-file payloads,
 * and the diff view's whole-file toggle all name a path plus a state. */
export type SnapshotState = string;

/** Read one path's content at one repository state. Attachment-free (ADR 14):
 * the path is absolute — or `~`-rooted, which the host expands — so nothing
 * about a Session is needed to resolve it. An omitted state reads the live
 * filesystem; see SnapshotState for the other values. */
export interface ReadFileRequest {
	verb: "readFile";
	path: string;
	state?: SnapshotState;
}

/** List one directory's immediate children at one repository state.
 * Attachment-free and absolutely addressed, like readFile. Listing is lazy:
 * one directory per expansion, never a recursive scan. */
export interface ListDirectoryRequest {
	verb: "listDirectory";
	path: string;
	state?: SnapshotState;
}

export interface ConsoleRequest {
	verb: "console";
	level: "log" | "warn" | "error";
	args: JsonValue[];
}

/** ADR 10 v2: show a recorded commit's details (`git show --stat`) in the
 * attached session's working directory. Like readFile, this consults the
 * live repository on explicit user demand — the stored stamp labels stay
 * the authoritative display source. */
export interface GitShowRequest {
	verb: "gitShow";
	/** Full object id of the recorded commit (validated before spawn). */
	commit: string;
}

/** Resolve the comparison base for reviewing one commit (ADR 14): the first
 * parent's object id, or the repository's empty-tree oid when the commit is a
 * root commit. Attachment-free, like the browser's read queries; the result
 * is a diff state the client can pass back, never a picker value. */
export interface GitBaseRequest {
	verb: "gitBase";
	/** Absolute directory whose repository owns the commit. */
	directory: string;
	/** Full object id of the commit to review (validated before spawn). */
	commit: string;
}

// ── Review surface: repository diff queries over the stamp timeline ─────

/** One endpoint of a review diff query. Either a pinned 40/64-hex object id
 * (a recorded stamp commit), "head" (the repository's current HEAD commit,
 * resolved at query time — recorded oids are pinned labels and can drift
 * after external commits), "index" (the staged tree), or "worktree" (the live
 * working tree, valid only as the `new` end). */
export type GitDiffState = string;

/** Change kind from git's raw status letter. `unknown` is the fallback for a
 * status git reports but the protocol does not name. Untracked files are
 * `added` and also carry `untracked`. */
export type GitDiffFileStatus =
	| "added"
	| "modified"
	| "deleted"
	| "renamed"
	| "copied"
	| "typechange"
	| "unmerged"
	| "unknown";

export interface GitDiffFileStat {
	/** Destination path (for renames: the new name). */
	path: string;
	/** Rename/copy source path when git detected one. */
	oldPath?: string;
	/** The change kind for this path (ADR 14). The file list itself comes from
	 * numstat; the status is a best-effort companion from the raw directive. */
	status: GitDiffFileStatus;
	additions: number;
	deletions: number;
	/** True for binary files (git reports `-` counts). */
	binary: boolean;
	/** True for an untracked (new, unstaged) file, which git's own diff
	 * excludes and the host lists separately. The client fetches its content
	 * through the payload verb like any other path (the old side is absent). */
	untracked?: boolean;
}

// ── Repository browser: directory listing over one state (ADR 14) ────────

/** One entry of a directory listing. `path` is absolute, so it can be fed
 * back to the browser's read and list queries unchanged. */
export interface DirectoryEntry {
	name: string;
	path: string;
	isDirectory: boolean;
}

/** One directory's immediate children at one repository state. `absent` is a
 * value, not an error: the directory does not exist at that state (a deleted
 * directory, a path outside a repository, or a path not in the named tree).
 * `omitted` counts entries the host's cap left out. */
export interface DirectoryListing {
	path: string;
	state: SnapshotState;
	entries: DirectoryEntry[];
	omitted: number;
	absent: boolean;
}

/** Diff two review states under an absolute directory (ADR 14). This is the
 * *directive* query: it returns the file list, statuses, and line counts, and
 * never patch text. Content comes from `readFile` per file, so the renderer
 * diffs whole snapshots rather than parsing git's patch format. Paths are
 * relative to `directory`, which also scopes the result to that subtree. */
export interface GitDiffRequest {
	verb: "gitDiff";
	directory: string;
	old: GitDiffState;
	new: GitDiffState;
}

export interface GitDiffReply {
	id: string;
	ok: true;
	files: GitDiffFileStat[];
	/** Changed files left out by the host's list cap. Present only when some
	 * were left out, so the review can report a partial list honestly. */
	filesOmitted?: number;
	/** Untracked files discovered beyond the host's inclusion cap. Present
	 * only when some were left out, so the summary can stay honest. */
	untrackedOmitted?: number;
}

// ── Project / session address shapes (ADR 11) ────────────────────────

/** Client cache prefix cursor (ADR 09). Identifies the committed entry
 * prefix a client already holds, so initial sync can send only the suffix. */
export interface PrefixCursor {
	sessionId: string;
	/** Entry id at ord = entryCount - 1 (the prefix anchor). */
	lastKnownId: string;
	/** Number of contiguous cached entries (ords 0..entryCount-1). */
	entryCount: number;
}

/** One allowlisted cwd and its pi session namespace (ADR 11). */
export interface ProjectInfo {
	id: string;
	cwd: string;
	/** The model a fresh session in this Project resolves to (pi's
	 * `findInitialModel`: the Project's settings default when authed, else a
	 * known-provider default, else the first available model) — what the
	 * Project home's picker shows as the pre-session default. Null when no
	 * model is available. The client still omits `model` on `newSession` when
	 * unset, so this is display-only, not a pinned choice. */
	defaultModel: ModelRef | null;
	/** The thinking level that same resolution yields (settings default or
	 * per-model override, else `medium`). Display-only like `defaultModel`. */
	defaultThinkingLevel: string | null;
}

/** Client-facing session address: project id + relative stem within the
 * Project's session directory. `stem` omits the `.jsonl` extension. */
export interface SessionAddress {
	projectId: string;
	stem: string;
}

/** Initial-sync session reference (ADR 11). `sessionId` is the cache identity;
 * `projectId` + `stem` are the client address. */
export interface SessionRef {
	projectId: string;
	sessionId: string;
	stem: string;
}

/** Total-order pagination cursor for `listSessions` (ADR 11). */
export interface SessionListCursor {
	sortTimeMs: number;
	stem: string;
}

/** Global active-session query (ADR 11). Not project-scoped, not paginated. */
export interface ListActiveSessionsRequest {
	verb: "listActiveSessions";
}

/** Detach the Connection from its activation (ADR 11). Connection-local:
 * unbinds without touching the activation registry. */
export interface DetachRequest {
	verb: "detach";
}

/** Terminate the live instance for a session address. Disposes the
 * daemon-side activation immediately — aborting and flushing any in-flight
 * turn — regardless of idle GC policy or attached Connections; the session
 * file survives and re-opening resumes it. Destructive and unconfirmed by
 * design: the client sends it only on explicit user action. */
export interface CloseSessionRequest {
	verb: "closeSession";
	projectId: string;
	stem: string;
}

/** Close a session, then move its file into the reserved archive prefix of the
 * Project's session directory. The close is unconditional (a dormant session
 * has no live instance, so only the move happens). Archived sessions are not
 * discovered by `listSessions` and their stems cannot be addressed, so an
 * archive leaves the client surface entirely; `ok: false` when there is no
 * durable file to move (a fresh session whose first turn never flushed). */
export interface ArchiveSessionRequest {
	verb: "archiveSession";
	projectId: string;
	stem: string;
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
	| OpenSessionRequest
	| NewSessionRequest
	| ListSessionsRequest
	| ListActiveSessionsRequest
	| GetDaemonInfoRequest
	| PullRequest
	| ListFilesRequest
	| ReadFileRequest
	| ListDirectoryRequest
	| GitShowRequest
	| GitBaseRequest
	| GitDiffRequest
	| ConsoleRequest
	| DetachRequest
	| CloseSessionRequest
	| ArchiveSessionRequest;

// ── Verb-specific reply shapes ───────────────────────────────────────────

/** Session metadata (ADR 11). `stem` is always present, including for an
 * unflushed session; `sessionId` is durable and is the cache/activation key.
 * `timestamp` is an ISO rendering of the ordering value: filesystem mtime for
 * a durable session, the in-memory header creation time before flush. */
export interface SessionInfo {
	projectId: string;
	sessionId: string;
	/** Relative session path minus the `.jsonl` extension. */
	stem: string;
	/** A live activation exists for this session. */
	active: boolean;
	/** The active session is streaming a turn. False when inactive. */
	isStreaming: boolean;
	name?: string;
	timestamp: string;
	firstMessageText?: string;
	/** Most recent user/assistant message text (one line, clamped) — the
	 * launcher's preview. A live activation reads it from its Document, so it is
	 * fresher than the last flush; inactive rows use the file scan. */
	lastMessageText?: string;
	/** Latest entry timestamp of the Session. The active-session list uses it
	 * for the row's activity time and ordering; `timestamp` stays the durable
	 * sort key (mtime / header creation). */
	lastActivityAt?: string;
	messageCount?: number;
}

export interface ListSessionsReply {
	id: string;
	ok: true;
	sessions: SessionInfo[];
	hasMore?: boolean;
	nextCursor?: SessionListCursor;
}

export interface ListActiveSessionsReply {
	id: string;
	ok: true;
	sessions: SessionInfo[];
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
	projects: ProjectInfo[];
	models: ModelInfo[];
	/** The daemon's global `enabledModels` scope (settings.json), resolved
	 * against the same catalogue as `models`. The Project home renders it as
	 * the picker's "Pinned" group before a session exists. Project-level
	 * `enabledModels` overrides in `.pi/settings.json` are intentionally not
	 * reflected — this is the global scope only. */
	scopedModels: ScopedModelInfo[];
	thinkingLevels: string[];
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

/** One path's content at a snapshot. `absent` is a value, not an error: a
 * deleted file, a path that is not in a commit's tree, or an unmerged index
 * entry. `binary` is detected host-side from a NUL byte, so the client never
 * renders mojibake. `path` is the resolved absolute path for a worktree read
 * and the repo-relative path for a commit or index read. */
export type SnapshotFile =
	| {
			kind: "file";
			state: SnapshotState;
			path: string;
			content: string;
			/** True when the file exceeded the byte cap and content is a prefix.
			 * A truncated snapshot is not diffable. */
			truncated: boolean;
			/** Full file size in bytes. */
			bytes: number;
	  }
	| { kind: "absent"; state: SnapshotState; path: string }
	| { kind: "binary"; state: SnapshotState; path: string; bytes: number };

/** The RPC reply is the payload plus the envelope. The host-side DaemonVerbs
 * seam returns the bare `SnapshotFile`. */
export type ReadFileReply = { id: string; ok: true } & SnapshotFile;

/** The index listing reply: the envelope plus the listing. */
export type ListDirectoryReply = { id: string; ok: true } & DirectoryListing;

export interface GitShowReply {
	id: string;
	ok: true;
	/** `git show --stat --no-color <commit>` stdout. */
	output: string;
	/** True when the output exceeded the byte cap and is a prefix. */
	truncated: boolean;
}

export interface GitBaseReply {
	id: string;
	ok: true;
	/** The commit to diff against: the commit's first parent, or the
	 * repository's empty-tree oid for a root commit. */
	baseline: string;
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
