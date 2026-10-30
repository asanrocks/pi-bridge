// ============================================================================
// connection-verbs — the typed verb handlers for one Connection's protocol
// (ADR 19).
//
// A verb handler is a seam function: it validates the request shape,
// captures its target before any await (the attachment capability, at
// handler entry), and replies through the context. It receives no socket,
// no transition state, and no runtime — the Session path is the capability's
// typed verbs, and the daemon path is the DaemonVerbs seam. The three
// attachment-changing transitions (openSession, newSession, detach) are not
// handlers: they are the Connection's serialized transition line and stay in
// connection.ts.
//
// `pull` is Connection-local (glossary B.6): it reads through the attached
// capability and registers live lazy-path subscriptions on the context — the
// subscription set is Connection state.
// ============================================================================

import type {
	ArchiveSessionRequest,
	AsrCredential,
	AsrCredentialsReply,
	ClientMessage,
	CloseSessionRequest,
	DirectoryListing,
	GetDaemonInfoReply,
	GitBaseRequest,
	GitDiffFileStat,
	GitDiffRequest,
	GitShowRequest,
	ImageContent,
	JsonValue,
	ListDirectoryRequest,
	ListFilesRequest,
	ListSessionsRequest,
	ModelRef,
	NavigateRequest,
	PinnedModelInfo,
	PrefixCursor,
	ProjectInfo,
	PromptRequest,
	PullRequest,
	ReadFileRequest,
	RenameSessionRequest,
	SessionInfo,
	SessionListCursor,
	SessionRef,
	SetLabelRequest,
	SetModelPinnedRequest,
	SetModelRequest,
	SetThinkingLevelRequest,
	SnapshotFile,
	TextPolishReply,
	TextPolishRequest,
} from "../core/index.ts";
import { MAX_IMAGE_BASE64_LENGTH, MAX_IMAGES_PER_MESSAGE } from "../core/index.ts";
import type { Connection } from "./connection.ts";
import type { SessionCapability } from "./session-actor.ts";

// ============================================================================
// DaemonVerbs — the Connection → Daemon seam (ADR 11)
// ============================================================================

export interface DaemonVerbs {
	/** Static Project configuration (ADR 11). Never a cwd allowlist: clients
	 * address sessions by `(projectId, stem)`. Async because per-Project
	 * default-model resolution may check auth. */
	getDaemonInfo: () => Promise<{
		projects: ProjectInfo[];
		models: {
			provider: string;
			id: string;
			name: string;
			reasoning: boolean;
			supportedThinkingLevels?: string[];
		}[];
		pinnedModels: PinnedModelInfo[];
		/** Resolved `provider/modelId` keys of the picker's normal tier (ADR 15). */
		visibleModels: string[];
		thinkingLevels: string[];
		devMode: boolean;
	}>;
	/** Pin or unpin one model in the daemon-global list (ADR 15). The new list
	 * arrives as a `pinned_models_changed` push. */
	setModelPinned: (provider: string, modelId: string, pinned: boolean) => Promise<void>;
	/** Dictation credentials, minted or registered by the daemon because a page
	 * can do neither (see `asr-credentials.ts`). Daemon-global: the ASR session
	 * runs from the browser to the endpoint, not through this socket. */
	asrCredentials: () => Promise<AsrCredential>;
	/** Rewrite one draft through the upstream text-polish service (see
	 * `text-polish.ts`). Daemon-global for the same reason: the page cannot speak
	 * the protocol, so the daemon does. Rejects when the feature is off. */
	textPolish: (text: string) => Promise<string>;
	/** Paginated history query for one Project. */
	listSessions: (
		projectId: string,
		max?: number,
		cursor?: SessionListCursor | null,
	) => Promise<{ sessions: SessionInfo[]; hasMore: boolean; nextCursor?: SessionListCursor }>;
	/** Global active/streaming snapshot. */
	listActiveSessions: () => SessionInfo[];
	/** Resolve-or-activate `(projectId, stem)` and attach this Connection. */
	openSession: (
		projectId: string,
		stem: string,
		conn: Connection,
		cursor?: PrefixCursor | null,
	) => Promise<{ ok: boolean; error?: string; session?: SessionRef }>;
	/** Create a new unflushed session in a Project and attach this Connection.
	 * The first prompt's `text` is required and admitted server-side before
	 * the attach (ADR 12 slice); a refused admission disposes the fresh
	 * activation, so no empty session is ever created. Optional `images`
	 * attach to the first prompt; optional `model` is applied before
	 * admission (the Project home's pre-session model choice). */
	newSession: (
		projectId: string,
		conn: Connection,
		text: string,
		options?: { images?: ImageContent[]; model?: ModelRef; thinkingLevel?: string },
	) => Promise<{ ok: boolean; error?: string; session?: SessionRef }>;
	/** Release this Connection's attachment (activation stays alive for GC). */
	detach: (conn: Connection) => void;
	/** Terminate the live instance for `(projectId, stem)` — a kill, not a
	 * GC: disposes the activation now, ignoring idle policy, streaming state,
	 * and attached Connections. */
	closeSession: (projectId: string, stem: string) => Promise<{ ok: boolean; error?: string }>;
	/** Close a session, then move its file into the reserved archive prefix.
	 * The close is unconditional; the move requires a durable file. */
	archiveSession: (projectId: string, stem: string) => Promise<{ ok: boolean; error?: string }>;
	/** Broadcast a Project's refreshed first page (rename, settle). */
	sessionsChanged: (projectId: string) => void;
	/** Path completion (ADR 12): resolved against `projectId`'s cwd, so it does
	 * not require an attachment (the Project home completes pre-send). Throws
	 * on an unknown Project. */
	listFiles: (prefix: string, projectId: string) => Array<{ path: string; isDirectory: boolean }>;
	/** Read one absolute path at one repository state (ADR 14). A missing path
	 * is an `absent` value, not a throw; an invalid state/path or a spawn
	 * failure throws (converted to an ok:false reply). An omitted state reads
	 * the live filesystem. Attachment-free. */
	readFile: (path: string, state?: string) => Promise<SnapshotFile>;
	/** List one absolute directory's immediate children at one repository state
	 * (ADR 14). A missing directory is an `absent` value, not a throw.
	 * Attachment-free. */
	listDirectory: (path: string, state?: string) => Promise<DirectoryListing>;
	/** Show a commit (`git show --stat`) for an ADR 10 change card. Throws on
	 * invalid commits and spawn failures (converted to an ok:false reply). */
	gitShow: (commit: string, cwd?: string) => Promise<{ output: string; truncated: boolean }>;
	/** Resolve the comparison base for reviewing one commit (ADR 14): its first
	 * parent, or the repository's empty-tree oid for a root commit.
	 * Attachment-free, like the browser's read queries. */
	gitBase: (directory: string, commit: string) => Promise<{ baseline: string }>;
	/** The browser's diff *directive* (file list, statuses, counts) between two
	 * repository states under an absolute directory (see GitDiffRequest).
	 * Throws like gitShow. Attachment-free. */
	gitDiff: (
		directory: string,
		oldState: string,
		newState: string,
	) => Promise<{ files: GitDiffFileStat[]; filesOmitted?: number; untrackedOmitted: number }>;
}

// ============================================================================
// Handlers
// ============================================================================

/** What a verb handler may touch: the daemon seam, the attachment capability,
 * subscription registration, the reply path, and the attachment generation
 * current at admission — nothing else of the Connection's state, and no
 * runtime. */
export interface VerbContext {
	/** The Daemon's verb implementation (ADR 11). */
	readonly daemonVerbs: DaemonVerbs;
	readonly devMode: boolean;
	/** The attachment a session verb addresses, captured at handler entry —
	 * before any await. A transition that completes while the command runs
	 * cannot retarget it: the command executes against, and reports on, the
	 * session that was attached when the request arrived. */
	requireAttachment(): SessionCapability;
	/** The attachment generation current when the request was admitted
	 * (ADR 19): the generation its reply's payload describes (a pull reads
	 * the attachment that was current at admission; a reattach supersedes
	 * it, so the client drops the reply). */
	readonly attachmentGeneration: number;
	/** Register a live lazy-path subscription (a pull on an unsealed entry:
	 * later patches on that path keep flowing to this Connection). */
	subscribe(fieldPath: string): void;
	/** The acknowledgement or error reply. */
	reply(id: string, ok: boolean, error?: string): void;
	/** A typed reply frame (query data, command results). */
	send(data: Record<string, unknown>): void;
}

export type VerbHandler = (ctx: VerbContext, msg: ClientMessage) => Promise<void>;

// ── Attached session verbs ─────────────────────────────────────────────────

const sessionVerbs: Record<string, VerbHandler> = {
	prompt: async (ctx, msg) => {
		const capability = ctx.requireAttachment();
		const m = msg as unknown as PromptRequest;
		if (typeof m.text !== "string") throw new Error("Missing `text`");
		// Light shape validation: images are opaque base64 blobs relayed
		// to the provider; only the envelope fields and wire limits are
		// checked here.
		const images = m.images;
		if (
			images !== undefined &&
			(!Array.isArray(images) ||
				images.length > MAX_IMAGES_PER_MESSAGE ||
				images.some(
					(i) =>
						i === null ||
						typeof i !== "object" ||
						typeof (i as ImageContent).data !== "string" ||
						(i as ImageContent).data.length > MAX_IMAGE_BASE64_LENGTH ||
						typeof (i as ImageContent).mimeType !== "string",
				))
		) {
			throw new Error("Invalid `images`");
		}
		await capability.prompt(m.text, images);
		ctx.reply(msg.id, true);
	},
	abort: async (ctx, msg) => {
		const capability = ctx.requireAttachment();
		await capability.abort();
		ctx.reply(msg.id, true);
	},
	discardSteer: async (ctx, msg) => {
		const capability = ctx.requireAttachment();
		await capability.discardSteer();
		ctx.reply(msg.id, true);
	},
	setModel: async (ctx, msg) => {
		const capability = ctx.requireAttachment();
		const m = msg as unknown as SetModelRequest;
		await capability.setModel(m.provider, m.model);
		ctx.reply(msg.id, true);
	},
	setThinkingLevel: async (ctx, msg) => {
		const capability = ctx.requireAttachment();
		const m = msg as unknown as SetThinkingLevelRequest;
		await capability.setThinkingLevel(m.level);
		ctx.reply(msg.id, true);
	},
	renameSession: async (ctx, msg) => {
		const capability = ctx.requireAttachment();
		const m = msg as unknown as RenameSessionRequest;
		if (typeof m.name !== "string") throw new Error("Missing `name`");
		await capability.renameSession(m.name);
		ctx.reply(msg.id, true);
		// The refresh broadcast belongs to the command's target — read from
		// the capture, never from the live attachment, which a transition
		// completing during the rename may have moved.
		ctx.daemonVerbs.sessionsChanged(capability.ref.projectId);
	},
	setLabel: async (ctx, msg) => {
		const capability = ctx.requireAttachment();
		const m = msg as unknown as SetLabelRequest;
		if (typeof m.entryId !== "string") throw new Error("Missing `entryId`");
		if (typeof m.label !== "string") throw new Error("Missing `label`");
		await capability.setLabel(m.entryId, m.label);
		ctx.reply(msg.id, true);
	},
	navigate: async (ctx, msg) => {
		const capability = ctx.requireAttachment();
		const m = msg as unknown as NavigateRequest;
		if (m.entryId !== null && typeof m.entryId !== "string") throw new Error("Missing `entryId`");
		await capability.navigate(m.entryId);
		ctx.reply(msg.id, true);
	},
	recoverTurn: async (ctx, msg) => {
		const capability = ctx.requireAttachment();
		// The runtime re-derives the boundary and refuses when the tail is
		// not recoverable; `action` reports which repair ran.
		const action = await capability.recoverTurn();
		ctx.send({ id: msg.id, ok: true, action: action as unknown as JsonValue });
	},
	gitShow: async (ctx, msg) => {
		const m = msg as unknown as GitShowRequest;
		if (typeof m.commit !== "string" || m.commit === "") throw new Error("Missing `commit`");
		// Requires an attachment: the recorded commit belongs to the attached
		// session's repository, so its cwd is the query base.
		const capability = ctx.requireAttachment();
		const result = await ctx.daemonVerbs.gitShow(m.commit, capability.cwd);
		ctx.send({ id: msg.id, ok: true, ...result });
	},
	// Connection-local (glossary B.6): reads the attached runtime's lazy
	// values and subscribes the live paths.
	pull: async (ctx, msg) => {
		const capability = ctx.requireAttachment();
		const m = msg as unknown as PullRequest;
		if (!m.requests || !Array.isArray(m.requests)) throw new Error("Missing `requests` array");
		const values = await capability.pull(m.requests);
		const out: Array<{ entryId: string; fieldPath: string; value: JsonValue }> = [];
		for (const value of values) {
			out.push({ entryId: value.entryId, fieldPath: value.fieldPath, value: value.value });
			// A live value streams further updates: the subscription keeps
			// later patches on that path flowing to this Connection.
			if (value.live) ctx.subscribe(value.fieldPath);
		}
		ctx.send({ id: msg.id, ok: true, values: out, generation: ctx.attachmentGeneration });
	},
};

// ── Daemon-routed verbs (queries, terminal session operations, dev) ────────

const daemonVerbs: Record<string, VerbHandler> = {
	closeSession: async (ctx, msg) => {
		const m = msg as unknown as CloseSessionRequest;
		if (typeof m.projectId !== "string" || m.projectId === "") throw new Error("Missing `projectId`");
		if (typeof m.stem !== "string" || m.stem === "") throw new Error("Missing `stem`");
		const result = await ctx.daemonVerbs.closeSession(m.projectId, m.stem);
		ctx.reply(msg.id, result.ok, result.error);
	},
	archiveSession: async (ctx, msg) => {
		const m = msg as unknown as ArchiveSessionRequest;
		if (typeof m.projectId !== "string" || m.projectId === "") throw new Error("Missing `projectId`");
		if (typeof m.stem !== "string" || m.stem === "") throw new Error("Missing `stem`");
		const result = await ctx.daemonVerbs.archiveSession(m.projectId, m.stem);
		ctx.reply(msg.id, result.ok, result.error);
	},
	listSessions: async (ctx, msg) => {
		const m = msg as unknown as ListSessionsRequest;
		if (typeof m.projectId !== "string" || m.projectId === "") throw new Error("Missing `projectId`");
		const result = await ctx.daemonVerbs.listSessions(m.projectId, m.max ?? undefined, m.cursor ?? null);
		const reply: Record<string, unknown> = {
			id: msg.id,
			ok: true,
			sessions: result.sessions,
			hasMore: result.hasMore,
		};
		if (result.nextCursor) reply.nextCursor = result.nextCursor;
		ctx.send(reply);
	},
	listActiveSessions: async (ctx, msg) => {
		ctx.send({ id: msg.id, ok: true, sessions: ctx.daemonVerbs.listActiveSessions() });
	},
	getDaemonInfo: async (ctx, msg) => {
		const info = await ctx.daemonVerbs.getDaemonInfo();
		const reply: GetDaemonInfoReply = { id: msg.id, ok: true, ...info };
		ctx.send(reply as unknown as Record<string, unknown>);
	},
	setModelPinned: async (ctx, msg) => {
		const m = msg as unknown as SetModelPinnedRequest;
		if (typeof m.provider !== "string" || m.provider === "") throw new Error("Missing `provider`");
		if (typeof m.modelId !== "string" || m.modelId === "") throw new Error("Missing `modelId`");
		if (typeof m.pinned !== "boolean") throw new Error("Missing `pinned`");
		await ctx.daemonVerbs.setModelPinned(m.provider, m.modelId, m.pinned);
		ctx.send({ id: msg.id, ok: true });
	},
	// Daemon-global and attachment-free, like getDaemonInfo: the ASR stream
	// belongs to the browser, so this socket carries only the credential. A
	// failure here is a plain RPC error the client shows.
	asrCredentials: async (ctx, msg) => {
		const auth = await ctx.daemonVerbs.asrCredentials();
		const reply: AsrCredentialsReply = { id: msg.id, ok: true, auth };
		ctx.send(reply as unknown as Record<string, unknown>);
	},
	// Daemon-global like asrCredentials, and for the same reason: the browser
	// cannot speak the upstream protocol, so the daemon does. The draft is
	// the only payload; the credential never leaves the host.
	textPolish: async (ctx, msg) => {
		const m = msg as unknown as TextPolishRequest;
		if (typeof m.text !== "string" || m.text.trim() === "") throw new Error("Missing `text`");
		const text = await ctx.daemonVerbs.textPolish(m.text);
		const reply: TextPolishReply = { id: msg.id, ok: true, text };
		ctx.send(reply as unknown as Record<string, unknown>);
	},
	// Project-addressed, not attachment-scoped (ADR 12): relative paths
	// resolve against the Project cwd, so the Project home's pre-send
	// completion needs no attachment.
	listFiles: async (ctx, msg) => {
		const m = msg as unknown as ListFilesRequest;
		if (typeof m.prefix !== "string") throw new Error("Missing `prefix`");
		if (typeof m.projectId !== "string" || m.projectId === "") throw new Error("Missing `projectId`");
		const entries = ctx.daemonVerbs.listFiles(m.prefix, m.projectId);
		ctx.send({ id: msg.id, ok: true, entries });
	},
	// Attachment-free (ADR 14): the path is absolute, so no Session is needed
	// to resolve it. An omitted state reads the live filesystem.
	readFile: async (ctx, msg) => {
		const m = msg as unknown as ReadFileRequest;
		if (typeof m.path !== "string" || m.path === "") throw new Error("Missing `path`");
		if (m.state !== undefined && (typeof m.state !== "string" || m.state === "")) {
			throw new Error("Invalid `state`");
		}
		const result = await ctx.daemonVerbs.readFile(m.path, m.state);
		ctx.send({ id: msg.id, ok: true, ...result });
	},
	// Attachment-free, like readFile.
	listDirectory: async (ctx, msg) => {
		const m = msg as unknown as ListDirectoryRequest;
		if (typeof m.path !== "string" || m.path === "") throw new Error("Missing `path`");
		if (m.state !== undefined && (typeof m.state !== "string" || m.state === "")) {
			throw new Error("Invalid `state`");
		}
		const listing = await ctx.daemonVerbs.listDirectory(m.path, m.state);
		ctx.send({ id: msg.id, ok: true, ...listing });
	},
	// Attachment-free: the absolute directory owns the commit.
	gitBase: async (ctx, msg) => {
		const m = msg as unknown as GitBaseRequest;
		if (typeof m.directory !== "string" || m.directory === "") throw new Error("Missing `directory`");
		if (typeof m.commit !== "string" || m.commit === "") throw new Error("Missing `commit`");
		const result = await ctx.daemonVerbs.gitBase(m.directory, m.commit);
		ctx.send({ id: msg.id, ok: true, ...result });
	},
	// Attachment-free (ADR 14): the absolute directory scopes the diff.
	gitDiff: async (ctx, msg) => {
		const m = msg as unknown as GitDiffRequest;
		if (typeof m.directory !== "string" || m.directory === "") throw new Error("Missing `directory`");
		if (typeof m.old !== "string" || typeof m.new !== "string") throw new Error("Missing diff states");
		const result = await ctx.daemonVerbs.gitDiff(m.directory, m.old, m.new);
		ctx.send({ id: msg.id, ok: true, ...result });
	},
	// Dev-mode console relay.
	console: async (ctx, msg) => {
		if (!ctx.devMode) throw new Error("console verb requires --dev mode");
		ctx.reply(msg.id, true);
	},
};

const verbTable: Record<string, VerbHandler> = { ...sessionVerbs, ...daemonVerbs };

/** The typed handler for one verb, or undefined for an unknown verb. The
 * three attachment transitions (openSession, newSession, detach) are handled
 * by the Connection itself — they are its serialized transition line. */
export function connectionVerbHandler(verb: string): VerbHandler | undefined {
	return verbTable[verb];
}
