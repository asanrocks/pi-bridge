// ============================================================================
// Pure document functions for the bridge data model (ADR 02).
// All functions are browser-safe: no Node, no fs, no DOM.
// Imports coding-agent types via `import type` only — erased at runtime.
// ============================================================================

import type {
	AgentSessionEvent,
	BranchSummaryEntry as PiBranchSummaryEntry,
	CompactionEntry as PiCompactionEntry,
	CustomEntry as PiCustomEntry,
	CustomMessageEntry as PiCustomMessageEntry,
	SessionInfoEntry as PiSessionInfoEntry,
	SessionEntry,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import {
	type AppendOp,
	type BashExecutionEntry,
	type CompactionEntry,
	type Content,
	type ContextUsage,
	type Document,
	type Entry,
	isLazyFieldPath,
	type JsonValue,
	type ModelRef,
	type Patch,
	type PatchOp,
	type RpcReply,
	type ServerPushMessage,
	type Stats,
	type Status,
	type ToolResultEntry,
	type Usage,
} from "./types.ts";

// ============================================================================
// Helpers
// ============================================================================

function jsonValue(v: unknown): JsonValue {
	try {
		return JSON.parse(JSON.stringify(v)) as JsonValue;
	} catch {
		return null;
	}
}

// ============================================================================
// Entry projection: SessionEntry → bridge Entry
// ============================================================================

type AnyRecord = Record<string, unknown>;

function toContent(block: unknown): Content {
	const b = block as AnyRecord;
	switch (b.type) {
		case "text":
			return {
				type: "text",
				text: b.text as string,
				textSignature: b.textSignature as string | undefined,
			};
		case "thinking":
			return {
				type: "thinking",
				// Normalize absent text (e.g. redacted blocks) to "" so wire `null`
				// has exactly one meaning: "not pulled" (ADR 09 invariant 4).
				thinking: (b.thinking as string | undefined) ?? "",
				thinkingSignature: b.thinkingSignature as string | undefined,
				redacted: b.redacted as boolean | undefined,
			};
		case "image":
			return {
				type: "image",
				data: b.data as string,
				mimeType: b.mimeType as string,
			};
		case "toolCall":
			return {
				type: "toolCall",
				id: b.id as string,
				name: b.name as string,
				// Store the partial arguments object directly — no serialization.
				// The wire contract: null = not pulled, object = partial or final.
				arguments: b.arguments as JsonValue,
				thoughtSignature: b.thoughtSignature as string | undefined,
			};
		default:
			return { type: "text", text: String(block) };
	}
}

function toMessageEntry(entry: SessionMessageEntry): Entry {
	const msg = entry.message;
	const role = msg.role as "user" | "assistant" | "system";
	const msgRaw = msg as unknown as AnyRecord;
	const rawContent = msgRaw.content;
	const contentBlocks: Content[] =
		typeof rawContent === "string"
			? [{ type: "text", text: rawContent }]
			: ((rawContent as unknown[]) ?? []).map(toContent);
	const base = {
		id: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		kind: "message" as const,
		role,
		content: contentBlocks,
	};

	if (role === "assistant") {
		const am = msg as unknown as AnyRecord;
		return {
			...base,
			api: am.api as string,
			provider: am.provider as string,
			model: am.model as string,
			responseModel: (am.responseModel as string | undefined) ?? null,
			responseId: (am.responseId as string | undefined) ?? null,
			usage: am.usage as JsonValue,
			stopReason: am.stopReason as string,
			errorMessage: (am.errorMessage as string | undefined) ?? null,
		} as unknown as Entry;
	}
	return base;
}

function toToolResultEntry(msg: unknown, entry: SessionMessageEntry): ToolResultEntry {
	const m = msg as AnyRecord;
	return {
		kind: "tool_result",
		id: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		toolCallId: m.toolCallId as string,
		toolName: m.toolName as string,
		content: ((m.content as unknown[]) ?? []).map(toContent),
		// Normalize absent details to {} (ADR 09 invariant 4: wire `null` only
		// means "not pulled").
		details: jsonValue(m.details) ?? {},
		isError: (m.isError as boolean) ?? false,
	};
}

function toBashExecutionEntry(msg: unknown, entry: SessionMessageEntry): BashExecutionEntry {
	const m = msg as AnyRecord;
	return {
		kind: "bash_execution",
		id: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		command: (m.command as string) ?? "",
		output: (m.output as string) ?? "",
		exitCode: typeof m.exitCode === "number" ? m.exitCode : null,
		cancelled: (m.cancelled as boolean) ?? false,
		truncated: (m.truncated as boolean) ?? false,
		fullOutputPath: (m.fullOutputPath as string | undefined) ?? null,
		excludeFromContext: (m.excludeFromContext as boolean) ?? false,
	};
}

function toCompactionEntry(entry: PiCompactionEntry): Entry {
	return {
		kind: "compaction",
		id: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		summary: entry.summary,
		firstKeptEntryId: entry.firstKeptEntryId,
		tokensBefore: entry.tokensBefore,
		details: jsonValue(entry.details),
		fromHook: entry.fromHook ?? false,
	};
}

function toBranchSummaryEntry(entry: PiBranchSummaryEntry): Entry {
	return {
		kind: "branch_summary",
		id: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		fromId: entry.fromId,
		summary: entry.summary,
		details: jsonValue(entry.details),
		fromHook: entry.fromHook ?? false,
	};
}

function toModelChangeEntry(entry: {
	id: string;
	parentId: string | null;
	timestamp: string;
	provider: string;
	modelId: string;
}): Entry {
	return {
		kind: "model_change",
		id: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		provider: entry.provider,
		modelId: entry.modelId,
	};
}

function toThinkingLevelChangeEntry(entry: {
	id: string;
	parentId: string | null;
	timestamp: string;
	thinkingLevel: string;
}): Entry {
	return {
		kind: "thinking_level_change",
		id: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		thinkingLevel: entry.thinkingLevel,
	};
}

function toLabelEntry(entry: {
	id: string;
	parentId: string | null;
	timestamp: string;
	targetId: string;
	label: string | undefined;
}): Entry {
	return {
		kind: "label",
		id: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		targetId: entry.targetId,
		label: entry.label,
	};
}

function toSessionInfoEntry(entry: PiSessionInfoEntry): Entry {
	return {
		kind: "session_info",
		id: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		name: entry.name,
	};
}

function toCustomEntry(entry: PiCustomEntry): Entry {
	return {
		kind: "custom",
		id: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		customType: entry.customType,
		data: jsonValue(entry.data),
	};
}

function toCustomMessageEntry(entry: PiCustomMessageEntry): Entry {
	const msgContent: Content[] =
		typeof entry.content === "string"
			? [{ type: "text", text: entry.content }]
			: (entry.content as unknown[]).map(toContent);
	return {
		kind: "custom_message",
		id: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		customType: entry.customType,
		content: msgContent,
		details: jsonValue(entry.details),
		display: entry.display,
	};
}

export function toEntry(entry: SessionEntry): Entry {
	if (entry.type === "message") {
		const msg = entry.message;
		if (msg.role === "toolResult") {
			return toToolResultEntry(msg, entry);
		}
		if ((msg as { role?: string }).role === "bashExecution") {
			return toBashExecutionEntry(msg, entry);
		}
		return toMessageEntry(entry);
	}
	switch (entry.type) {
		case "compaction":
			return toCompactionEntry(entry);
		case "branch_summary":
			return toBranchSummaryEntry(entry);
		case "model_change":
			return toModelChangeEntry(entry);
		case "thinking_level_change":
			return toThinkingLevelChangeEntry(entry);
		case "label":
			return toLabelEntry(entry);
		case "session_info":
			return toSessionInfoEntry(entry);
		case "custom":
			return toCustomEntry(entry);
		case "custom_message":
			return toCustomMessageEntry(entry);
		default: {
			const e = entry as unknown as { id: string; parentId: string | null; timestamp: string; type: string };
			return {
				kind: "custom" as const,
				id: e.id,
				parentId: e.parentId,
				timestamp: e.timestamp,
				customType: e.type,
				data: null,
			};
		}
	}
}

// ============================================================================
// Status derivation
// ============================================================================

export function deriveStatus(
	entries: Record<string, Entry>,
	overrides?: {
		leafId?: string | null;
		name?: string;
		model?: ModelRef;
		thinkingLevel?: string;
		isStreaming?: boolean;
		isCompacting?: boolean;
		contextUsage?: ContextUsage | null;
	},
): Status {
	const leafId = overrides?.leafId ?? deriveLeafId(entries);
	return {
		leafId,
		name: overrides?.name ?? deriveName(entries),
		model: overrides?.model ?? deriveModel(entries),
		thinkingLevel: overrides?.thinkingLevel ?? deriveThinkingLevel(entries),
		isStreaming: overrides?.isStreaming ?? false,
		isCompacting: overrides?.isCompacting ?? false,
		stats: deriveStats(entries, leafId),
		/* contextUsage is set externally by the Manager — never derived from entries */
		contextUsage: overrides?.contextUsage ?? null,
		/* pendingSteer is event-driven (queue_update) — never derived from entries */
		pendingSteer: [],
	};
}

function deriveLeafId(entries: Record<string, Entry>): string | null {
	let last: string | null = null;
	for (const id of Object.keys(entries)) {
		if (!id.startsWith("pending:")) {
			last = id;
		}
	}
	return last;
}

function deriveModel(entries: Record<string, Entry>): ModelRef {
	let ref: ModelRef = { provider: "", modelId: "" };
	for (const id of Object.keys(entries)) {
		const e = entries[id];
		if (!id.startsWith("pending:") && e.kind === "model_change" && "modelId" in e) {
			ref = { provider: e.provider, modelId: e.modelId };
		}
	}
	return ref;
}

function deriveThinkingLevel(entries: Record<string, Entry>): string {
	let level = "off";
	for (const id of Object.keys(entries)) {
		const e = entries[id];
		if (!id.startsWith("pending:") && e.kind === "thinking_level_change" && "thinkingLevel" in e) {
			level = e.thinkingLevel;
		}
	}
	return level;
}

function deriveName(entries: Record<string, Entry>): string {
	let name = "";
	for (const id of Object.keys(entries)) {
		const e = entries[id];
		if (!id.startsWith("pending:") && e.kind === "session_info" && e.name !== undefined) {
			name = e.name;
		}
	}
	return name;
}

function deriveStats(entries: Record<string, Entry>, leafId: string | null): Stats {
	// Walk the branch path from leafId → root via parentId
	const path: Entry[] = [];
	let cursor = leafId;
	while (cursor && entries[cursor]) {
		path.push(entries[cursor]);
		cursor = entries[cursor].parentId;
	}
	path.reverse(); // root → leaf

	// Walk along the path, accumulating usage. When a compaction entry is
	// encountered, skip entries before its firstKeptEntryId — they were
	// compacted away and no longer contribute to the current context.
	// This mirrors buildContextEntries() in pi's session-manager.ts.
	let compaction: CompactionEntry | undefined;
	for (let i = path.length - 1; i >= 0; i--) {
		if (path[i].kind === "compaction") {
			compaction = path[i] as unknown as CompactionEntry;
			break;
		}
	}

	const contextEntryIds = new Set<string>();
	if (compaction) {
		const compactionIdx = (path as unknown[]).indexOf(compaction);
		contextEntryIds.add(compaction.id);
		let foundFirstKept = false;
		for (let i = 0; i < compactionIdx; i++) {
			if (path[i].id === compaction.firstKeptEntryId) {
				foundFirstKept = true;
			}
			if (foundFirstKept) {
				contextEntryIds.add(path[i].id);
			}
		}
		for (let i = compactionIdx + 1; i < path.length; i++) {
			contextEntryIds.add(path[i].id);
		}
	} else {
		for (const e of path) {
			contextEntryIds.add(e.id);
		}
	}

	// Usage is per-request: each assistant's usage.input is the *total*
	// prompt for that request, not a delta. Summing across messages would
	// double-count. Only the last assistant's usage reflects the current
	// input context. output and cost.total are genuinely additive.
	let lastUsage: Usage | undefined;
	let output = 0;
	let costTotal = 0;
	let msgs = 0;

	for (const e of path) {
		if (!contextEntryIds.has(e.id)) continue;
		if (e.kind === "message" && e.usage) {
			lastUsage = e.usage;
			output += e.usage.output;
			costTotal += e.usage.cost.total;
			msgs++;
		}
	}

	let input = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let total = 0;

	if (lastUsage) {
		input = lastUsage.input;
		cacheRead = lastUsage.cacheRead;
		cacheWrite = lastUsage.cacheWrite;
		total = lastUsage.totalTokens;
	}

	const tokens: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number } = {
		input,
		output,
		total,
	};
	if (cacheRead !== 0) tokens.cacheRead = cacheRead;
	if (cacheWrite !== 0) tokens.cacheWrite = cacheWrite;

	return {
		tokens,
		cost: { total: costTotal },
		messages: msgs,
	};
}

// ============================================================================
// initFromEntries — bootstrap from pi's durable state
// ============================================================================

export function initFromEntries(entries: SessionEntry[]): Document {
	const entryMap: Record<string, Entry> = {};
	for (let i = 0; i < entries.length; i++) {
		const projected = toEntry(entries[i]);
		// ADR 09: bootstrapped entries get their file position immediately.
		projected.ord = i;
		entryMap[entries[i].id] = projected;
	}
	return {
		status: deriveStatus(entryMap),
		entries: entryMap,
		scopedModels: [],
	};
}

// ============================================================================
// applyPatch — produce a new Document by applying a Patch with structural sharing
// ============================================================================

// ============================================================================
// Invariant guard — enabled by tests via harness; zero-cost when off.
// The O(1) root-flip check in applyPatch/setAtPath is always on (it is the
// property ADR 07's React selectors depend on). The O(n) sibling-sharing
// checks in cloneSet/cloneRemove are gated behind this flag.
// ============================================================================

let _invariantChecks = false;

/** Enable O(n) structural-sharing invariant checks. Called by test harness. */
export function __enableInvariantChecks(): void {
	_invariantChecks = true;
}

// ============================================================================
// applyPatch — produce a new Document by applying a Patch with structural sharing
// ============================================================================

/**
 * Apply a Patch (ordered list of PatchOps) to a Document.
 * Returns a new Document root with structural sharing: only the touched
 * path and its ancestors are shallow-copied; everything else keeps its
 * object reference.
 *
 * A thrown op leaves the caller's root at the pre-Patch value — no
 * half-applied Patch.
 */
export function applyPatch(root: Document, ops: PatchOp[]): Document {
	const input = root;
	for (const op of ops) {
		root = applyOp(root, op);
	}
	// Invariant (ADR 08 §4): non-empty ops must produce a new root reference.
	// This is the property React selectors depend on for change detection.
	// Always on — O(1) reference compare, zero overhead.
	if (ops.length > 0 && root === input) {
		throw new Error("invariant violation: applyPatch with non-empty ops must return a new root");
	}
	return root;
}

function applyOp(root: Document, op: PatchOp): Document {
	switch (op.op) {
		case "add":
		case "replace":
			return setAtPath(root, op.path, op.value);
		case "remove":
			return removeAtPath(root, op.path);
		case "move":
			return moveAtPath(root, op.from, op.path);
		case "append":
			return appendAtPath(root, op.path, op.value);
		default:
			throw new Error(`Unknown patch op: ${(op as PatchOp).op}`);
	}
}

export function getAtPath(obj: unknown, path: string): unknown {
	const keys = parsePath(path);
	let cur = obj;
	for (const key of keys) {
		if (cur === null || cur === undefined) return undefined;
		cur = (cur as AnyRecord)[key];
	}
	return cur;
}

/**
 * Return a new root with `value` set at `path`, structurally sharing
 * everything not on the path.
 */
export function setAtPath(root: Document, path: string, value: unknown): Document {
	const keys = parsePath(path);
	if (keys.length === 0) return value as Document;
	const result = cloneSet(root, keys, value) as Document;
	// Invariant (ADR 08 §4): a path-based set must produce a new root.
	if (result === root) {
		throw new Error("invariant violation: setAtPath must return a new root");
	}
	return result;
}

/** shallow-clone every object along `keys`, set `value` at the leaf. */
function cloneSet(obj: unknown, keys: string[], value: unknown): unknown {
	const [head, ...tail] = keys;
	if (Array.isArray(obj)) {
		const idx = Number(head);
		const clone = [...obj];
		clone[idx] = tail.length === 0 ? value : cloneSet(clone[idx], tail, value);
		return clone;
	}
	if (obj && typeof obj === "object") {
		const rec = obj as AnyRecord;
		const clone = { ...rec };
		clone[head] = tail.length === 0 ? value : cloneSet(rec[head] ?? autoCreate(tail), tail, value);
		// Invariant (ADR 08 §5): sibling keys share references with original.
		// O(n) check — gated behind test-only flag.
		if (_invariantChecks) {
			for (const key of Object.keys(rec)) {
				if (key !== head && clone[key] !== rec[key]) {
					throw new Error("invariant violation: cloneSet must structurally share sibling object keys");
				}
			}
		}
		return clone;
	}
	// obj is null/undefined/primitive — auto-create path
	if (tail.length === 0) return { [head]: value };
	return { [head]: cloneSet(autoCreate(tail), tail, value) };
}

/** Guess whether the next key wants an array or object (used when path doesn't exist). */
function autoCreate(keys: string[]): unknown {
	if (keys.length === 0) return {};
	return /^\d+$/.test(keys[0]) ? [] : {};
}

/** Return a new root with the key at `path` removed. */
function removeAtPath(root: Document, path: string): Document {
	const keys = parsePath(path);
	if (keys.length === 0) return root;
	return cloneRemove(root, keys) as Document;
}

function cloneRemove(obj: unknown, keys: string[]): unknown {
	if (keys.length === 1) {
		const last = keys[0];
		if (Array.isArray(obj)) {
			const clone = [...obj];
			clone.splice(Number(last), 1);
			return clone;
		}
		if (obj && typeof obj === "object") {
			const rec = obj as AnyRecord;
			const { [last]: _, ...rest } = rec;
			// Invariant (ADR 08 §5): sibling keys share references.
			// O(n) check — gated behind test-only flag.
			if (_invariantChecks) {
				for (const key of Object.keys(rest)) {
					if (rest[key] !== rec[key]) {
						throw new Error("invariant violation: cloneRemove must structurally share sibling object keys");
					}
				}
			}
			return rest;
		}
		return obj;
	}
	const [head, ...tail] = keys;
	if (Array.isArray(obj)) {
		const idx = Number(head);
		const clone = [...obj];
		clone[idx] = cloneRemove(clone[idx], tail);
		return clone;
	}
	if (obj && typeof obj === "object") {
		const rec = obj as AnyRecord;
		if (!(head in rec)) return obj;
		const clone = { ...rec };
		clone[head] = cloneRemove(rec[head], tail);
		// Invariant (ADR 08 §5): sibling keys share references.
		// O(n) check — gated behind test-only flag.
		if (_invariantChecks) {
			for (const key of Object.keys(rec)) {
				if (key !== head && clone[key] !== rec[key]) {
					throw new Error("invariant violation: cloneRemove must structurally share sibling object keys");
				}
			}
		}
		return clone;
	}
	return obj;
}

function moveAtPath(root: Document, from: string, to: string): Document {
	const value = getAtPath(root, from);
	const afterRemove = removeAtPath(root, from);
	return setAtPath(afterRemove, to, value);
}

function appendAtPath(root: Document, path: string, value: string): Document {
	const existing = getAtPath(root, path);
	if (typeof existing === "string") {
		return setAtPath(root, path, existing + value);
	}
	return setAtPath(root, path, value);
}

function parsePath(path: string): string[] {
	if (path === "" || path === "/") return [];
	const segments = path.startsWith("/") ? path.slice(1) : path;
	return segments.split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

// ============================================================================
// snapshotForWire — strip lazy fields for the wire (Init message)
// ============================================================================

export function snapshotForWire(doc: Document): Document {
	const entries: Record<string, Entry> = {};
	for (const [id, entry] of Object.entries(doc.entries)) {
		entries[id] = stripLazyFields(entry);
	}
	return { status: doc.status, entries, scopedModels: doc.scopedModels };
}

export function stripLazyFields(entry: Entry): Entry {
	const clone = { ...entry } as AnyRecord;
	if ("content" in clone) {
		const content = clone.content;
		if (clone.kind === "tool_result") {
			// Tool result content is lazy — null the entire array
			clone.content = null;
		} else if (Array.isArray(content)) {
			clone.content = content.map((block: AnyRecord) => {
				const b = { ...block };
				if (b.type === "thinking" && "thinking" in b) b.thinking = null;
				if (b.type === "toolCall" && "arguments" in b) b.arguments = null;
				return b;
			});
		}
	}
	if ("details" in clone && clone.kind === "tool_result") {
		clone.details = null;
	}
	return clone as unknown as Entry;
}

// ============================================================================
// filterPatchForSocket — drop ops on lazy paths the socket hasn't subscribed
// to, and sanitize lazy content embedded in parent-path op values (ADR 09).
// ============================================================================

export function filterPatchForSocket(ops: PatchOp[], subscriptions: Set<string>): PatchOp[] {
	const result: PatchOp[] = [];
	for (const op of ops) {
		const path = op.op === "move" ? op.from : op.path;
		if (isLazyFieldPath(path)) {
			if (isSubscribedPath(path, subscriptions)) result.push(op);
			continue;
		}
		// Non-lazy path: the op itself passes, but its value may embed lazy
		// content (entry-root add from reconcile/entry_appended, block-level
		// replace from toolcall_end). Strip unsubscribed lazy subfields.
		if ((op.op === "add" || op.op === "replace") && op.value !== null && typeof op.value === "object") {
			const sanitized = sanitizeOpValue(op.path, op.value as AnyRecord, subscriptions);
			if (sanitized !== op.value) {
				result.push({ ...op, value: sanitized as unknown as JsonValue });
				continue;
			}
		}
		result.push(op);
	}
	return result;
}

/** Exact or ancestor subscription match. */
function isSubscribedPath(path: string, subscriptions: Set<string>): boolean {
	if (subscriptions.has(path)) return true;
	// Walk up parent paths: /entries/<id>/content/0/text → check
	//   /entries/<id>/content/0, /entries/<id>/content, /entries/<id>
	let parent = path;
	while (parent.includes("/")) {
		parent = parent.replace(/\/[^/]+$/, "");
		if (subscriptions.has(parent)) return true;
	}
	return false;
}

const ENTRY_ROOT_RE = /^\/entries\/[^/]+$/;
const CONTENT_BLOCK_RE = /^\/entries\/[^/]+\/content\/\d+$/;

/**
 * Strip lazy subfields embedded in a parent-path op value, honoring
 * subscriptions. Returns the original reference when nothing changes —
 * never mutates the input.
 */
function sanitizeOpValue(path: string, value: AnyRecord, subscriptions: Set<string>): AnyRecord {
	if (ENTRY_ROOT_RE.test(path)) return sanitizeEntryValue(path, value, subscriptions);
	if (CONTENT_BLOCK_RE.test(path)) return sanitizeBlockValue(path, value, subscriptions);
	return value;
}

function sanitizeEntryValue(path: string, entry: AnyRecord, subscriptions: Set<string>): AnyRecord {
	if (entry.kind === "tool_result") {
		// Tool result content/details are lazy as whole fields.
		const stripContent = entry.content != null && !isSubscribedPath(`${path}/content`, subscriptions);
		const stripDetails = entry.details != null && !isSubscribedPath(`${path}/details`, subscriptions);
		if (!stripContent && !stripDetails) return entry;
		const clone = { ...entry };
		if (stripContent) clone.content = null;
		if (stripDetails) clone.details = null;
		return clone;
	}
	const content = entry.content;
	if (Array.isArray(content)) {
		let changed = false;
		const sanitizedContent = content.map((block, i) => {
			const sanitized = sanitizeBlockValue(`${path}/content/${i}`, block as AnyRecord, subscriptions);
			if (sanitized !== block) changed = true;
			return sanitized;
		});
		if (changed) return { ...entry, content: sanitizedContent };
	}
	return entry;
}

function sanitizeBlockValue(path: string, block: AnyRecord, subscriptions: Set<string>): AnyRecord {
	if (block.type === "thinking" && block.thinking != null && !isSubscribedPath(`${path}/thinking`, subscriptions)) {
		return { ...block, thinking: null };
	}
	if (block.type === "toolCall" && block.arguments != null && !isSubscribedPath(`${path}/arguments`, subscriptions)) {
		return { ...block, arguments: null };
	}
	return block;
}

// ---------------------------------------------------------------------------
// CompactCodec — stateful wire-frame compaction for streaming appends
// ---------------------------------------------------------------------------
//
// During streaming, the diff engine emits one single-op `append` patch per
// token, all targeting the same path (e.g. `.../content/0/thinking`). The
// JSON-Patch frame envelope (`{"kind":"patch","ops":[{"op":"append",
// "path":"...","value":"x"}]}`) is ~100 bytes to deliver a ~7-byte token.
//
// CompactCodec sits at the WS serialization boundary. When consecutive
// single-op `append` patches target the *same* path, the encoder emits the
// value as a bare JSON string (no envelope); the decoder restores the append
// op before handing the frame up. Upper layers (diff engine, mirror, onPush)
// are untouched — they keep emitting and consuming full patch frames.
//
// Invariants:
//  - The remembered path is only valid across consecutive single-op
//    `append` patches to the same path. Anything else clears it: multi-op
//    patches, non-append ops (notably `move`, which relocates a path),
//    `replace` snapshots, out-of-band pushes, and RPC replies.
//  - The encoder always sends a full patch frame to prime a new path before
//    emitting compact frames for it, so a compact frame only arrives when the
//    decoder's remembered path is already set (WS reliable-ordered; reconnect
//    uses `replace`, which resets state on both sides).
//  - `append` values are always strings (AppendOp.value: string), so the
//    compact form is a bare JSON string — unambiguous vs. the object form.

export class CompactCodec {
	private lastAppendPath: string | null = null;

	/** Clear remembered state. Call on (re)connect. */
	reset(): void {
		this.lastAppendPath = null;
	}

	/** Host → wire. Emits the compact bare-string form for a single-op
	 * `append` patch whose path matches the remembered one; otherwise
	 * serializes the full frame and updates state per the invariants. */
	encodeOutgoing(frame: Record<string, unknown>): string {
		const op = singleAppendOp(frame);
		if (op !== null) {
			if (this.lastAppendPath !== null && op.path === this.lastAppendPath) {
				return JSON.stringify(op.value);
			}
			this.lastAppendPath = op.path;
			return JSON.stringify(frame);
		}
		this.lastAppendPath = null;
		return JSON.stringify(frame);
	}

	/** Wire → client. Restores the append op for compact (bare-string) frames;
	 * passes objects through and updates remembered state. Throws if a compact
	 * frame arrives with no remembered path — a protocol violation that can't
	 * happen under reliable-ordered delivery + the encoder's prime-first rule. */
	decodeIncoming(raw: string): ServerPushMessage | RpcReply {
		const msg: JsonValue = JSON.parse(raw) as JsonValue;
		if (typeof msg === "string") {
			if (this.lastAppendPath === null) {
				throw new Error("compact append frame arrived with no remembered path");
			}
			return {
				kind: "patch",
				ops: [{ op: "append", path: this.lastAppendPath, value: msg }],
			};
		}
		const op = singleAppendOp(msg);
		this.lastAppendPath = op ? op.path : null;
		return msg as ServerPushMessage | RpcReply;
	}
}

/** If `msg` is a `{kind:"patch"}` frame with exactly one string-valued
 * `append` op, return that op; otherwise null. Shared by encode and decode
 * so both sides apply the same compact-eligibility rule. */
function singleAppendOp(msg: unknown): AppendOp | null {
	if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return null;
	const obj = msg as Record<string, unknown>;
	if (obj.kind !== "patch" || !Array.isArray(obj.ops) || obj.ops.length !== 1) return null;
	// Initial-sync patches carry `session` and are never compacted (ADR 11):
	// the bare-string form has no place to keep the address.
	if (obj.session !== undefined) return null;
	const op = obj.ops[0] as Record<string, unknown> | undefined;
	if (op === undefined || op === null) return null;
	if (op.op !== "append" || typeof op.path !== "string" || typeof op.value !== "string") return null;
	return { op: "append", path: op.path, value: op.value };
}

// ---------------------------------------------------------------------------
// Provisional naming
// ---------------------------------------------------------------------------

const PROVISIONAL_MESSAGE = "pending:message";
const PROVISIONAL_USER_PREFIX = "pending:user:";
const PROVISIONAL_TOOL_PREFIX = "pending:";

function userOrdinal(entries: Record<string, Entry>): number {
	let count = 0;
	for (const id of Object.keys(entries)) {
		if (id.startsWith(PROVISIONAL_USER_PREFIX)) count++;
	}
	return count + 1;
}

// ============================================================================
// applyEvent — consume AgentSessionEvent, produce Patch
// ============================================================================

export function applyEvent(doc: Document, event: AgentSessionEvent): Patch | null {
	const ops: PatchOp[] = [];

	switch (event.type) {
		case "agent_start":
			ops.push({ op: "replace", path: "/status/isStreaming", value: true });
			break;

		case "agent_settled":
			ops.push({ op: "replace", path: "/status/isStreaming", value: false });
			break;

		case "message_start": {
			const msg = event.message;
			if (msg.role === "user") {
				const n = userOrdinal(doc.entries);
				const id = `${PROVISIONAL_USER_PREFIX}${n}`;
				ops.push({
					op: "add",
					path: `/entries/${id}`,
					value: userMessageSkeleton(id, doc.status.leafId, msg as unknown as AnyRecord),
				});
			} else if (msg.role === "assistant") {
				ops.push({
					op: "add",
					path: `/entries/${PROVISIONAL_MESSAGE}`,
					value: assistantMessageSkeleton(doc.status.leafId, msg as unknown as AnyRecord),
				});
				ops.push({ op: "replace", path: "/status/leafId", value: PROVISIONAL_MESSAGE });
			}
			break;
		}

		case "message_update": {
			const ame = event.assistantMessageEvent;
			const entryId = PROVISIONAL_MESSAGE;
			const prefix = `/entries/${entryId}`;

			switch (ame.type) {
				case "text_start":
					ops.push({
						op: "add",
						path: `${prefix}/content/${ame.contentIndex}`,
						value: { type: "text", text: "" } as JsonValue,
					});
					break;
				case "text_delta":
					ops.push({
						op: "append",
						path: `${prefix}/content/${ame.contentIndex}/text`,
						value: ame.delta,
					});
					break;
				case "text_end":
					ops.push({
						op: "replace",
						path: `${prefix}/content/${ame.contentIndex}/text`,
						value: ame.content,
					});
					break;
				case "thinking_start":
					ops.push({
						op: "add",
						path: `${prefix}/content/${ame.contentIndex}`,
						value: { type: "thinking", thinking: null } as JsonValue,
					});
					break;
				case "thinking_delta":
					ops.push({
						op: "append",
						path: `${prefix}/content/${ame.contentIndex}/thinking`,
						value: ame.delta,
					});
					break;
				case "thinking_end":
					ops.push({
						op: "replace",
						path: `${prefix}/content/${ame.contentIndex}/thinking`,
						value: ame.content,
					});
					break;
				case "toolcall_start": {
					// The partial message carries the tool call with name, id, and
					// arguments populated immediately from the LLM stream start event.
					// Pi's LLM adapters reconstruct the partial arguments object from
					// streaming JSON fragments — we store it directly as JsonValue.
					// The wire contract: null = not pulled, object = partial or final.
					const partial = ame.partial as unknown as
						| { content: Array<{ type: string; id: string; name: string; arguments: Record<string, unknown> }> }
						| undefined;
					const block = partial?.content[ame.contentIndex];
					const name = block?.type === "toolCall" ? block.name : "";
					const id = block?.type === "toolCall" ? block.id : "";
					const args = block?.type === "toolCall" ? (block.arguments as JsonValue) : null;
					ops.push({
						op: "add",
						path: `${prefix}/content/${ame.contentIndex}`,
						value: { type: "toolCall", id, name, arguments: args } as JsonValue,
					});
					break;
				}
				case "toolcall_delta": {
					// Diff the current arguments object against the new partial
					// from pi's parseStreamingJson. Emit granular json-patch ops
					// (add/replace/append on sub-paths) so the client mirror
					// always holds a valid partial object — no serialization.
					const partial = ame.partial as unknown as
						| { content: Array<{ type: string; arguments: Record<string, unknown> }> }
						| undefined;
					const block = partial?.content[ame.contentIndex];
					if (block?.type === "toolCall") {
						const argsPath = `${prefix}/content/${ame.contentIndex}/arguments`;
						const currentArgs = getAtPath(doc, argsPath) as Record<string, unknown> | undefined;
						ops.push(
							...computeObjectDiff(currentArgs ?? {}, block.arguments as Record<string, unknown>, argsPath),
						);
					}
					break;
				}
				case "toolcall_end": {
					const tc = ame.toolCall as unknown as {
						id: string;
						name: string;
						arguments: Record<string, unknown>;
						thoughtSignature?: string;
					};
					ops.push({
						op: "replace",
						path: `${prefix}/content/${ame.contentIndex}`,
						value: toolCallBlockToJson(tc),
					});
					break;
				}
				case "done":
				case "error":
					break;
			}
			break;
		}

		case "message_end": {
			const msg = event.message;
			if (msg.role === "assistant") {
				const am = msg as unknown as AnyRecord;
				const prefix = `/entries/${PROVISIONAL_MESSAGE}`;
				ops.push({ op: "replace", path: `${prefix}/api`, value: am.api as string });
				ops.push({ op: "replace", path: `${prefix}/provider`, value: am.provider as string });
				ops.push({ op: "replace", path: `${prefix}/model`, value: am.model as string });
				if (am.responseModel)
					ops.push({ op: "replace", path: `${prefix}/responseModel`, value: am.responseModel as string });
				if (am.responseId)
					ops.push({ op: "replace", path: `${prefix}/responseId`, value: am.responseId as string });
				ops.push({ op: "replace", path: `${prefix}/stopReason`, value: am.stopReason as string });
				if (am.errorMessage)
					ops.push({ op: "replace", path: `${prefix}/errorMessage`, value: am.errorMessage as string });
				if (am.usage) ops.push({ op: "replace", path: `${prefix}/usage`, value: am.usage as JsonValue });
				ops.push({ op: "replace", path: "/status/leafId", value: PROVISIONAL_MESSAGE });
			} else if (msg.role === "toolResult") {
				const toolCallId = (msg as unknown as AnyRecord).toolCallId as string;
				const toolId = findToolProvisional(doc.entries, toolCallId);
				if (toolId) ops.push({ op: "replace", path: "/status/leafId", value: toolId });
			} else {
				const userId = findLatestUserProvisional(doc.entries);
				if (userId) ops.push({ op: "replace", path: "/status/leafId", value: userId });
			}
			break;
		}

		case "tool_execution_start": {
			const id = `${PROVISIONAL_TOOL_PREFIX}${event.toolCallId}`;
			ops.push({
				op: "add",
				path: `/entries/${id}`,
				value: toolResultSkeleton(id, doc.status.leafId, event.toolCallId, event.toolName),
			});
			break;
		}

		case "tool_execution_update": {
			const id = `${PROVISIONAL_TOOL_PREFIX}${event.toolCallId}`;
			const prefix = `/entries/${id}`;
			if (event.partialResult?.content !== undefined) {
				ops.push({ op: "replace", path: `${prefix}/content`, value: jsonValue(event.partialResult.content) });
			}
			if (event.partialResult?.details !== undefined) {
				ops.push({ op: "replace", path: `${prefix}/details`, value: jsonValue(event.partialResult.details) });
			}
			break;
		}

		case "tool_execution_end": {
			const id = `${PROVISIONAL_TOOL_PREFIX}${event.toolCallId}`;
			const prefix = `/entries/${id}`;
			if (event.result?.content !== undefined) {
				const content = Array.isArray(event.result.content)
					? (event.result.content as unknown[]).map(toContent)
					: jsonValue(event.result.content);
				ops.push({ op: "replace", path: `${prefix}/content`, value: content as JsonValue });
			}
			if (event.result?.details !== undefined) {
				ops.push({ op: "replace", path: `${prefix}/details`, value: jsonValue(event.result.details) });
			}
			ops.push({ op: "replace", path: `${prefix}/isError`, value: event.isError });
			break;
		}

		case "compaction_start":
			ops.push({ op: "replace", path: "/status/isCompacting", value: true });
			break;

		case "compaction_end":
			ops.push({ op: "replace", path: "/status/isCompacting", value: false });
			break;

		case "thinking_level_changed":
			ops.push({ op: "replace", path: "/status/thinkingLevel", value: event.level });
			break;

		case "entry_appended": {
			const entry = toEntry(event.entry);
			ops.push({ op: "add", path: `/entries/${entry.id}`, value: entry as unknown as JsonValue });
			ops.push({ op: "replace", path: "/status/leafId", value: entry.id });
			break;
		}

		case "session_info_changed": {
			if (event.name !== undefined) {
				ops.push({ op: "replace", path: "/status/name", value: event.name });
			}
			break;
		}

		// Events with no document effect
		case "queue_update": {
			// Surface the session's steer queue as wire-eager status state. The
			// manager's prompt verb enqueues via streamingBehavior: "steer";
			// this patch lets clients render pending draft chips. followUp is
			// not surfaced (steer-only MVP).
			ops.push({ op: "replace", path: "/status/pendingSteer", value: [...event.steering] });
			break;
		}
		case "turn_end":
		case "agent_end":
		case "turn_start":
		case "auto_retry_start":
		case "auto_retry_end":
			break;
	}

	return ops.length > 0 ? { ops } : null;
}

// ============================================================================
// reconcile — diff getEntries() against Document, produce Patch
// ============================================================================

export interface ReconcileOptions {
	name?: string;
	model?: ModelRef;
	thinkingLevel?: string;
	contextUsage?: ContextUsage | null;
}

export function reconcile(doc: Document, piEntries: SessionEntry[], options?: ReconcileOptions): Patch | null {
	const ops: PatchOp[] = [];

	// Walk by index (ADR 09): ord is the file position, so already-known later
	// entries must be visited to assign their ord when an earlier hole is
	// discovered — the old `if (doc.entries[piEntry.id]) continue` skip could
	// not do that.
	for (let i = 0; i < piEntries.length; i++) {
		const piEntry = piEntries[i];
		const known = doc.entries[piEntry.id];
		if (known) {
			// Normally a no-op: ord is stable for one logical session. A diff
			// means history was rewritten (hand-edit, fixture); correct it so
			// mirrors converge.
			if (known.ord !== i) {
				ops.push({ op: "replace", path: `/entries/${piEntry.id}/ord`, value: i });
			}
			continue;
		}

		const provisional = findProvisional(doc.entries, piEntries, piEntry);
		if (provisional) {
			ops.push({ op: "move", from: `/entries/${provisional.id}`, path: `/entries/${piEntry.id}` });
			ops.push({ op: "replace", path: `/entries/${piEntry.id}/id`, value: piEntry.id });
			ops.push({ op: "add", path: `/entries/${piEntry.id}/parentId`, value: piEntry.parentId });
			ops.push({ op: "add", path: `/entries/${piEntry.id}/timestamp`, value: piEntry.timestamp });
			// Invariant 7 (architecture §7): committed entries never hold null
			// lazy fields. Streaming skeletons start null and the filling events
			// are conditional (absent tool details, abort before *_end), so the
			// seal backfills any still-null lazy field from the durable pi
			// entry — toEntry normalizes genuinely-absent values.
			ops.push(...backfillLazyFields(doc.entries[provisional.id], piEntry));
			// ADR 09: the sealed entry becomes cacheable — it now has ord.
			ops.push({ op: "add", path: `/entries/${piEntry.id}/ord`, value: i });
		} else {
			// ADR 09 invariant 2: the canonical document holds real values.
			// Lazy stripping happens only at the wire boundary
			// (snapshotForWire + filterPatchForSocket).
			const projected = toEntry(piEntry);
			projected.ord = i;
			ops.push({ op: "add", path: `/entries/${piEntry.id}`, value: projected as unknown as JsonValue });
		}
	}

	const lastId = piEntries.length > 0 ? piEntries[piEntries.length - 1].id : null;
	if ((doc.status.leafId ?? null) !== lastId) {
		ops.push({ op: "replace", path: "/status/leafId", value: lastId });
	}

	if (options?.name !== undefined && doc.status.name !== options.name) {
		ops.push({ op: "replace", path: "/status/name", value: options.name });
	}
	if (options?.model !== undefined) {
		const cur = doc.status.model;
		if (cur.provider !== options.model.provider || cur.modelId !== options.model.modelId) {
			ops.push({ op: "replace", path: "/status/model", value: options.model as unknown as JsonValue });
		}
	}
	if (options?.thinkingLevel !== undefined && doc.status.thinkingLevel !== options.thinkingLevel) {
		ops.push({ op: "replace", path: "/status/thinkingLevel", value: options.thinkingLevel });
	}
	if ("contextUsage" in (options ?? {})) {
		const newCU = (options as ReconcileOptions).contextUsage ?? null;
		if (JSON.stringify(doc.status.contextUsage) !== JSON.stringify(newCU)) {
			ops.push({ op: "replace" as const, path: "/status/contextUsage", value: newCU as unknown as JsonValue });
		}
	}

	// ── Recompute aggregate stats after all reconcile ops ────────────
	// deriveStats is only called during initFromEntries; reconcile must
	// re-derive it so the rollup reflects newly-committed message usage
	// and compaction boundaries.
	//
	// Build the effective entry map as it will look after reconcile ops
	// are applied: committed entries from piEntries (preferring the
	// streaming-enriched bridge projection when available), plus any
	// provisional entries not yet committed.
	const effectiveEntries: Record<string, Entry> = {};
	for (const pe of piEntries) {
		effectiveEntries[pe.id] = doc.entries[pe.id] ?? toEntry(pe);
	}
	for (const [id, entry] of Object.entries(doc.entries)) {
		if (id.startsWith("pending:")) {
			effectiveEntries[id] = entry;
		}
	}

	const effectiveLeafId = piEntries.length > 0 ? piEntries[piEntries.length - 1].id : doc.status.leafId;
	const newStats = deriveStats(effectiveEntries, effectiveLeafId);
	if (JSON.stringify(newStats) !== JSON.stringify(doc.status.stats)) {
		ops.push({ op: "replace", path: "/status/stats", value: newStats as unknown as JsonValue });
	}

	return ops.length > 0 ? { ops } : null;
}

/**
 * Replace ops for lazy fields the stream left null on a sealing provisional
 * entry (invariant 7). The durable pi entry is authoritative; block indices
 * align because streaming built the same content order. Type mismatches
 * (defensive) skip the block rather than guess.
 */
function backfillLazyFields(prov: Entry, piEntry: SessionEntry): PatchOp[] {
	const durable = toEntry(piEntry);
	const prefix = `/entries/${piEntry.id}`;
	const ops: PatchOp[] = [];

	if (prov.kind === "tool_result" && durable.kind === "tool_result") {
		if (prov.content === null) {
			ops.push({ op: "replace", path: `${prefix}/content`, value: durable.content as unknown as JsonValue });
		}
		if (prov.details === null) {
			ops.push({ op: "replace", path: `${prefix}/details`, value: durable.details });
		}
		return ops;
	}

	if (prov.kind === "message" && durable.kind === "message") {
		for (let i = 0; i < prov.content.length; i++) {
			const p = prov.content[i];
			const d = durable.content[i];
			if (!d || d.type !== p.type) continue;
			if (p.type === "thinking" && p.thinking === null && d.type === "thinking") {
				ops.push({ op: "replace", path: `${prefix}/content/${i}/thinking`, value: d.thinking });
			}
			if (p.type === "toolCall" && p.arguments === null && d.type === "toolCall") {
				ops.push({ op: "replace", path: `${prefix}/content/${i}/arguments`, value: d.arguments });
			}
		}
	}

	return ops;
}

// ============================================================================
// Provisional matching helpers
// ============================================================================

export function findProvisional(
	entries: Record<string, Entry>,
	piEntries: SessionEntry[],
	piEntry: SessionEntry,
): { id: string } | null {
	if (piEntry.type !== "message") return null;

	const msg = piEntry.message;
	if (msg.role === "assistant") {
		return entries[PROVISIONAL_MESSAGE] ? { id: PROVISIONAL_MESSAGE } : null;
	}
	if (msg.role === "toolResult") {
		const toolCallId = (msg as unknown as AnyRecord).toolCallId as string;
		const id = `${PROVISIONAL_TOOL_PREFIX}${toolCallId}`;
		return entries[id] ? { id } : null;
	}
	if (msg.role === "user") {
		let ordinal = 0;
		for (const e of piEntries) {
			if (e.type === "message" && (e.message as unknown as AnyRecord).role === "user") {
				// Only count user messages not yet committed in the Document
				if (!entries[e.id]) ordinal++;
			}
			if (e.id === piEntry.id) break;
		}
		const id = `${PROVISIONAL_USER_PREFIX}${ordinal}`;
		return entries[id] ? { id } : null;
	}
	return null;
}

function findToolProvisional(entries: Record<string, Entry>, toolCallId: string): string | null {
	const id = `${PROVISIONAL_TOOL_PREFIX}${toolCallId}`;
	return entries[id] ? id : null;
}

function findLatestUserProvisional(entries: Record<string, Entry>): string | null {
	let latest = "";
	for (const id of Object.keys(entries)) {
		if (id.startsWith(PROVISIONAL_USER_PREFIX)) latest = id;
	}
	return latest || null;
}

// ============================================================================
// Skeleton factories (for applyEvent)
// ============================================================================

function assistantMessageSkeleton(parentId: string | null, msg: AnyRecord): JsonValue {
	return {
		kind: "message",
		id: PROVISIONAL_MESSAGE,
		parentId,
		timestamp: "",
		role: "assistant",
		content: [],
		api: msg.api,
		provider: msg.provider,
		model: msg.model,
		responseModel: msg.responseModel ?? null,
		responseId: null,
		usage: null,
		stopReason: null,
		errorMessage: null,
	} as unknown as JsonValue;
}

function userMessageSkeleton(id: string, parentId: string | null, msg: AnyRecord): JsonValue {
	return {
		kind: "message",
		id,
		parentId,
		timestamp: "",
		role: "user",
		content:
			typeof msg.content === "string"
				? [{ type: "text", text: msg.content }]
				: (msg.content as unknown[]).map(toContent),
	} as unknown as JsonValue;
}

// ============================================================================
// Object diff — compute granular json-patch ops between two partial objects
// ============================================================================

/**
 * Diff two partial arguments objects and produce granular json-patch ops.
 * For string values that grow by appending (common during LLM streaming),
 * detect prefix matches and emit `append` for the suffix. Recurses into
 * nested objects *and* arrays: when an array element's string field grows
 * by a suffix (e.g. a streamed `edits[].newText`), emits `append` on the
 * element's sub-path instead of replacing the whole array. New trailing
 * elements emit `add` at the new last index (applyPatch's `add` sets index
 * == length, which appends); removals are emitted high-to-low so
 * splice-shifts don't corrupt lower indices.
 */
/** Exported for testing. Diff two partial objects into granular json-patch ops. */
export function computeObjectDiff(
	oldObj: Record<string, unknown>,
	newObj: Record<string, unknown>,
	basePath: string,
): PatchOp[] {
	const ops: PatchOp[] = [];
	const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);

	for (const key of allKeys) {
		const keyPath = `${basePath}/${key}`;
		const oldVal = (oldObj as AnyRecord)[key];
		const newVal = (newObj as AnyRecord)[key];

		if (!(key in newObj)) {
			ops.push({ op: "remove", path: keyPath });
		} else if (!(key in oldObj)) {
			ops.push({ op: "add", path: keyPath, value: newVal as JsonValue });
		} else if (oldVal !== newVal) {
			ops.push(...diffValue(oldVal, newVal, keyPath));
		}
	}

	return ops;
}

/** Diff two values that both exist at the same path. Strings get suffix
 * detection; plain objects and arrays recurse; anything else (mismatched
 * types, primitives, null) replaces. `null` is `typeof "object"` in JS, so
 * it is handled before the object branches. */
function diffValue(oldVal: unknown, newVal: unknown, path: string): PatchOp[] {
	if (oldVal === newVal) return [];

	if (oldVal === null || newVal === null || typeof oldVal !== "object" || typeof newVal !== "object") {
		// At least one side is primitive (or null). Strings get suffix detection;
		// everything else replaces.
		if (typeof oldVal === "string" && typeof newVal === "string") {
			if (newVal.startsWith(oldVal) && newVal.length > oldVal.length) {
				return [{ op: "append", path, value: newVal.slice(oldVal.length) }];
			}
			return [{ op: "replace", path, value: newVal as JsonValue }];
		}
		return [{ op: "replace", path, value: newVal as JsonValue }];
	}

	// Both non-null objects.
	const oldIsArray = Array.isArray(oldVal);
	const newIsArray = Array.isArray(newVal);
	if (oldIsArray && newIsArray) {
		return diffArray(oldVal as unknown[], newVal as unknown[], path);
	}
	if (!oldIsArray && !newIsArray) {
		return computeObjectDiff(oldVal as Record<string, unknown>, newVal as Record<string, unknown>, path);
	}
	// One is array, other is object — structural type change.
	return [{ op: "replace", path, value: newVal as JsonValue }];
}

/** Diff two arrays element-wise: in-place diffs for shared indices, then
 * removals (high-to-low) for shrunk tails, then adds (low-to-high) for grown
 * tails. applyPatch applies ops sequentially, so add-at-index == current
 * length appends; remove-at-index splices and shifts, hence the ordering. */
function diffArray(oldArr: unknown[], newArr: unknown[], basePath: string): PatchOp[] {
	const ops: PatchOp[] = [];
	const minLen = Math.min(oldArr.length, newArr.length);

	for (let i = 0; i < minLen; i++) {
		ops.push(...diffValue(oldArr[i], newArr[i], `${basePath}/${i}`));
	}
	for (let i = oldArr.length - 1; i >= newArr.length; i--) {
		ops.push({ op: "remove", path: `${basePath}/${i}` });
	}
	for (let i = oldArr.length; i < newArr.length; i++) {
		ops.push({ op: "add", path: `${basePath}/${i}`, value: newArr[i] as JsonValue });
	}

	return ops;
}

function toolResultSkeleton(id: string, parentId: string | null, toolCallId: string, toolName: string): JsonValue {
	return {
		kind: "tool_result",
		id,
		parentId,
		timestamp: "",
		toolCallId,
		toolName,
		content: null,
		details: null,
		isError: false,
	} as unknown as JsonValue;
}

function toolCallBlockToJson(tc: {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	thoughtSignature?: string;
}): JsonValue {
	return {
		type: "toolCall",
		id: tc.id,
		name: tc.name,
		// The final arguments object — already a Record from pi's parser.
		// Store it directly as JsonValue, no serialization.
		arguments: tc.arguments as unknown as JsonValue,
		thoughtSignature: tc.thoughtSignature ?? null,
	} as unknown as JsonValue;
}

// ============================================================================
// resolveFieldPath — resolve a field-path within an entry (used by daemon)
// ============================================================================

/**
 * Resolve a JSON-path field from an entry object.
 * Handles paths like `/entries/<id>/content/3/text` by stripping the entry prefix.
 */
export function resolveFieldPath(entry: Record<string, unknown>, fieldPath: string): unknown {
	const parts = fieldPath.split("/");
	if (parts.length < 4) return undefined;
	const innerPath = parts.slice(3);

	let cur: unknown = entry;
	for (const key of innerPath) {
		if (cur === null || cur === undefined) return undefined;
		if (Array.isArray(cur)) {
			const idx = Number(key);
			if (Number.isNaN(idx) || idx < 0 || idx >= cur.length) return undefined;
			cur = cur[idx];
		} else if (typeof cur === "object") {
			cur = (cur as Record<string, unknown>)[key];
		} else {
			return undefined;
		}
	}

	return cur;
}
