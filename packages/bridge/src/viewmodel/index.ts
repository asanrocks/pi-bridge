// ============================================================================
// ViewModel — pure projection from Document + store state to display-ready
// ViewModel (ADR 07: flatten + structure pipeline).
//
//   Document.entries
//     → flatten (entry → block descriptors, tool result joins)
//     → structure (leaf-path walk, cross-entry merge, siblings) → ViewModel
//     → render (consecutive-action detection → vertical line, renderer-owned)
//
// Browser-safe: no node:* imports, no DOM. Pure functions only.
// ============================================================================

import type { PullRequestItem } from "../core/client.ts";
import {
	GIT_STAMP_CUSTOM_TYPE,
	type GitIdentity,
	type GitStampAnchor,
	parseGitStampEntry,
	sameGitIdentity,
} from "../core/git-stamp.ts";
import type {
	BashExecutionEntry,
	Content,
	Document,
	Entry,
	ImageContent,
	JsonValue,
	MessageEntry,
	ModelInfo,
	ModelRef,
	ToolCallBlock,
	ToolResultEntry,
	Usage,
} from "../core/types.ts";
import { applyPatchInput, extractApplyPatchPaths } from "./apply-patch.ts";

// ---------------------------------------------------------------------------
// ViewModel types (ADR 07 §ViewModel types)
// ---------------------------------------------------------------------------

export interface ViewModel {
	turns: TurnVM[];
	leafEntryId: string | null;
	/** Deepest entry shared by the rendered path and the live path — the
	 * divergence point. `null` when the rendered path IS the live path (no
	 * peek). Render-only orientation aid; never fed back into the pipeline. */
	forkPointId: string | null;
	/** Structural identity of the leaf path (entry ids + provisional content
	 * counts). Stable when the path is unchanged. The renderer's auto-scroll
	 * reads this instead of re-walking the document during render. */
	pathKey: string;
	/** Content-delta identity of the leaf entry: per-block `text`/`thinking`
	 * field lengths. Captures intra-block streaming growth (text_delta /
	 * thinking_delta) that `pathKey` (block counts only) misses. Excludes
	 * lazy tool arguments/results so expand/pull toggles don't fire it. The
	 * renderer gates auto-scroll on this with `isStreaming` so completed-turn
	 * lazy pulls (also text/thinking-length changes) stay excluded. */
	streamingKey: string;
	/** Readable-text identity of the leaf path (see {@link leafTextKey}): only
	 * user/assistant `text` blocks, not thinking, tool calls, or images. The
	 * jump-to-bottom notifier uses this so thinking/tool churn below the
	 * viewport does not raise the new-content dot — only text landing there
	 * does. */
	textKey: string;
}

export type TurnVM = UserTurn | AssistantTurn | SystemTurn | UserBashTurn | GitChangeTurn;

/** ADR 10 v2: a boundary git identity stamp rendered as an ordered
 * transcript item (prompt / user_bash_end anchors, or a turn-anchor stamp
 * with no open turn). Mid-turn stamps (tool_end / turn_end inside a turn) do
 * not produce this — they fold into the turn's action group as
 * {@link InlineGitStamp}s. Either way it is not a conversation turn:
 * no sibling navigation, editing, or tool-result joining. */
export interface GitChangeTurn {
	kind: "gitChange";
	/** The stamp entry id (stable React key). */
	entryId: string;
	index: number;
	timestamp: string;
	/** The newly observed identity. */
	identity: GitIdentity;
	/** HEAD subject at observation; null for v1 stamps and failed lookups. */
	commitSubject: string | null;
	/** The observation boundary the stamp was taken at. */
	anchor: GitStampAnchor;
	/** First valid stamp on the path — an initial state recording, not a
	 * transition. */
	isInitial: boolean;
}

export interface UserTurn {
	kind: "user";
	entryId: string;
	index: number;
	/** Concatenated text content (wire-eager). */
	text: string;
	/** Image attachments in the user message (wire-eager, in order). */
	images: ImageContent[];
	/** Entries with same parentId (for variant pager). */
	siblings?: string[];
	currentSiblingIndex?: number;
	timestamp: string;
	/** Wall-clock ms from the most recent assistant completion (across ALL
	 * branches, not just the leaf path) to this send — the user's "thought
	 * for" interval. Anchoring on the previous assistant message, not the
	 * leaf-path predecessor, fixes re-edits: editing history message A into
	 * A0 forks a branch with no on-path predecessor, yet the deliberation
	 * interval runs from the old branch's leaf assistant. Omitted when no
	 * assistant has completed before this send (the first turn). */
	thoughtForMs?: number;
	/** ADR 10 git identity stamps: the effective identity at this send — the
	 * last valid stamp on the path at or before this user message, carried
	 * forward. Undefined when the path has no stamps (unknown). */
	gitIdentity?: GitIdentity;
	/** Subject of that effective identity's commit (v2 stamps only); shown as
	 * the identity chip's tooltip. Null/undefined when unknown. */
	gitCommitSubject?: string | null;
}

export interface UserBashTurn {
	kind: "userBash";
	entryId: string;
	index: number;
	timestamp: string;
	command: string;
	output: string;
	exitCode: number | null;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath: string | null;
	excludeFromContext: boolean;
}

export interface AssistantTurn {
	kind: "assistant";
	/** First entry of the merged turn. */
	entryId: string;
	index: number;
	blocks: AssistantBlockVM[];
	/** From last entry in merged turn. */
	model?: string;
	/** From last entry in merged turn. */
	provider?: string;
	/** From last entry in merged turn. */
	usage?: Usage;
	/** The turn's stop reason — "stop", "toolUse", "end_turn", "error", "aborted", "length". */
	stopReason?: string;
	/** Unique turn identity. For a turn starting at block 0 of its first
	 * entry this equals `entryId`; for a turn starting mid-entry it is
	 * `${entryId}:b${blockIndex}`. With turn merging a turn always starts at
	 * block 0, so `turnKey === entryId` in practice — but React keys and the
	 * previous-VM reuse map key on this, never `entryId`, so a future split
	 * rule cannot silently break identity. */
	turnKey: string;
	/** Error/abort message when stopReason is abnormal. */
	errorMessage?: string;
	/** Parsed provider error when `errorMessage` follows the
	 * `"<status>: {json}"` shape: first-class `status`/`message` plus the
	 * remaining JSON fields as loose KV. Falls back to `{ message: raw }` for
	 * any string that does not parse (plain message, truncated JSON, trailing
	 * metadata). */
	parsedError?: ParsedProviderError;
	timestamp: string;
	/** ISO seal anchoring this turn's timing: the seal of the path entry
	 * preceding the turn's first block (usually the user message that opened
	 * the turn). The renderer uses it for the live "working for Xs" tick while
	 * the turn streams; the viewmodel also uses it as the total-duration base. */
	turnStartedAt?: string;
	/** Total wall-clock ms from turnStartedAt to the turn's window end (the
	 * last seal, extended past the closing entry to the latest tool result
	 * the turn's tool calls issued). Undefined while the turn is streaming. */
	totalMs?: number;
	/** Time in tool execution (total minus Σ assistant-generation windows).
	 * Parallel tools are handled via a per-batch max (the wall-clock span to
	 * the last parallel result), not a per-tool sum. Undefined while streaming. */
	toolMs?: number;
	/** Context-window occupancy when the turn's last entry was generated,
	 * as a percentage of the model's contextWindow. Fed-context basis
	 * (input + cacheRead + cacheWrite — what the model saw), matching pi's
	 * compaction skip rule: aborted/error stops and all-zero usage are
	 * untrustworthy and yield undefined. Reported on the turn whose first
	 * ref is block 0 of its entry (the turn's first entry) — one reading per
	 * turn, no duplicates. */
	contextPercent?: number;
	/** Change in context occupancy vs. the previous valid reading on the
	 * path, in percentage points. Undefined when there is no prior reading
	 * (first turn), after a model switch (different contextWindow makes the
	 * readings incomparable), or below the 1% display threshold — except a
	 * negative delta (compaction drop), which always renders. */
	contextDeltaPercent?: number;
	/** ADR 10 v2: git changes observed while this turn was open (tool_end /
	 * turn_end anchors), folded into the turn instead of splitting it. Each
	 * inline git stamp renders as its own card inside its action group, after the action
	 * it follows, and the group summary gains a `git:` segment. */
	gitChanges?: InlineGitStamp[];
}

/** One mid-turn git identity transition (ADR 10 v2). */
export interface InlineGitStamp {
	/** The stamp entry id. */
	entryId: string;
	timestamp: string;
	/** The newly observed identity. */
	identity: GitIdentity;
	/** HEAD subject at observation; null for v1 stamps and failed lookups. */
	commitSubject: string | null;
	/** The observation boundary. */
	anchor: GitStampAnchor;
	/** First valid stamp on the path — an initial state recording. */
	isInitial: boolean;
	/** Render position: the last block accumulated when the stamp was
	 * observed — the card renders after the action with this key
	 * (`"${entryId}:b${blockIndex}"`). */
	afterBlockKey: string;
}

export type SystemTurnType = "compaction" | "branch_summary" | "model_switch";

export interface SystemTurn {
	kind: "system";
	type: SystemTurnType;
	entryId: string;
	index: number;
	/** Markdown, for compaction/branch_summary (wire-eager). */
	summary?: string;
	/** Final state of a merged turn of consecutive model_change /
	 * thinking_level_change entries. pi appends these back-to-back on a
	 * model switch (setModel → appendModelChange, then the thinking re-clamp
	 * → appendThinkingLevelChange), so the turn collapses into one turn.
	 * provider/modelId are empty for a thinking-only turn; thinkingLevel is
	 * undefined when the turn didn't change the level. */
	switchTo?: { provider: string; modelId: string; thinkingLevel?: string };
}

export type AssistantBlockVM = TextBlockVM | ToolActionVM | ThinkActionVM;

/** A tool or thinking action — the per-action unit inside an ActionGroup. */
export type ActionVM = ToolActionVM | ThinkActionVM;

export interface TextBlockVM {
	blockType: "text";
	entryId: string;
	blockIndex: number;
	/** Always populated — wire-eager. May be stale mid-stream; the renderer
	 * subscribes to its own content slice for live text. */
	text: string;
	isProvisional: boolean;
}

export interface ToolActionVM {
	blockType: "tool";
	entryId: string;
	blockIndex: number;
	toolName: string;
	toolCallId: string;
	/** null until lazy pull. Partial object during streaming. */
	arguments: JsonValue | null;
	result: ToolResultSnapshot | null;
	/** e.g. "read: src/main.ts" */
	summary: string;
	status: "pending" | "running" | "done" | "error";
}

export interface ThinkActionVM {
	blockType: "thinking";
	entryId: string;
	blockIndex: number;
	/** null until lazy pull. */
	thinking: string | null;
	isProvisional: boolean;
	redacted: boolean;
}

export interface ToolResultSnapshot {
	/** ToolResultEntry id (for lazy pull paths). */
	entryId: string;
	isError: boolean;
}

// ---------------------------------------------------------------------------
// Store projection input — minimal slice needed by computeViewModel
// ---------------------------------------------------------------------------

export interface ViewModelInput {
	document: Document;
	models: ModelInfo[];
	/** Rendered-leaf override (web peek): project the path from this entry
	 * instead of `status.leafId`. `null`/`undefined` follows the live leaf.
	 * Only committed entries (with `ord`) are valid targets — callers enforce
	 * this (store `setRenderLeaf`); an unknown id falls back to the live leaf
	 * so a stale override can never blank the view. */
	viewLeafId?: string | null;
}

// ---------------------------------------------------------------------------
// computeViewModel
// ---------------------------------------------------------------------------

/**
 * Project a Document into a display-ready ViewModel.
 *
 * 1. Leaf-path projection — walk from status.leafId up via parentId, reverse.
 * 2. Structure — collapse the path into turns. Consecutive assistant
 *    entries merge into one turn; the turn closes at a user message, a
 *    system turn (compaction, branch_summary, model switch), a user bash
 *    execution, or the end of the path. Text blocks do NOT split the turn:
 *    the per-message split experiment (8386faacf) multiplied turns ~5x on
 *    real sessions (54 → 271 on before-compaction.jsonl) for a cosmetic
 *    gain — segmentBlocks already renders interleaved text/action groups
 *    in order within a turn. tool_result and other invisible entries
 *    neither render nor break the turn accumulation.
 * 3. Flatten — each assistant entry's content becomes block descriptors;
 *    tool calls join their ToolResultEntry by toolCallId.
 * 4. Siblings — user messages get variant-pager info by parentId.
 *
 * Identity preservation (ADR 07 invariant 3c): when the underlying data is
 * unchanged, TurnVM and block VM references from `previousVM` are reused so
 * React.memo stays effective across recomputations.
 */
export function computeViewModel(input: ViewModelInput, previousVM?: ViewModel): ViewModel {
	const { document: doc } = input;
	const viewLeaf = resolveViewLeaf(doc, input.viewLeafId);
	const path = projectLeafPath(doc, viewLeaf);
	const toolResultMap = buildToolResultMap(doc.entries);

	const prevTurns = new Map<string, TurnVM>();
	const prevBlocks = new Map<string, AssistantBlockVM>();
	if (previousVM) {
		for (const t of previousVM.turns) {
			prevTurns.set(`${t.kind}:${t.entryId}`, t);
			if (t.kind === "assistant") {
				for (const b of t.blocks) prevBlocks.set(`${b.entryId}:${b.blockIndex}`, b);
			}
		}
	}

	const turns: TurnVM[] = [];
	// Turn accumulator: (entry, blockIndex) refs for the assistant blocks of
	// the current turn. Refs — not entries — are the accumulation unit, so a
	// future mid-entry split rule would not need a rewrite.
	let pending: BlockRef[] = [];
	// Accumulator for a turn of consecutive model_change/thinking_level_change
	// entries (see SystemTurn.switchTo). Flushed when any other turn-producing
	// entry appears or at the end of the path.
	let switchTurn: { firstId: string; provider: string; modelId: string; thinkingLevel: string } | null = null;
	const flushSwitchTurn = () => {
		if (switchTurn === null) return;
		turns.push(buildSwitchTurn(switchTurn, turns.length, prevTurns));
		switchTurn = null;
	};
	// Timing anchor: the seal of the last timestamped path entry seen before
	// the turn's first block (usually the user message that opened the turn).
	// User turns anchor on the wall-clock previous ASSISTANT completion
	// across all branches (see buildUserTurn), so they need no leaf-path
	// predecessor.
	let prevSealTs = "";
	let pendingAnchor = "";

	// Context-usage tracking along the leaf path. Each assistant entry's
	// usage measures the context the model saw at that generation (fed
	// context: input + cacheRead + cacheWrite — cumulative by construction,
	// no summation needed). prevReading carries the last valid reading
	// (percent + the model it was taken under); a model switch invalidates
	// the delta comparison (different contextWindow) but not the absolute
	// percent chain: the new model's turns still get their own percent, the
	// first one just carries no delta.
	let prevReading: { percent: number; model: string } | null = null;
	// ADR 10 fold state: the effective git identity carried forward from the
	// last valid stamp on the leaf path, with that commit's subject (the
	// tooltip on a user turn's identity chip). Stamps are transitions, so every
	// user turn after a stamp inherits it until the next transition.
	let carriedGit: { identity: GitIdentity; subject: string | null } | null = null;
	// True once any valid stamp has been seen on the path — the next stamp is
	// a transition rather than an initial state recording.
	let seenGitStamp = false;
	// ADR 10 v2: mid-turn stamps (tool_end/turn_end observed while a turn is
	// open) folded into the pending turn; attached to the turn at flushPending.
	let pendingGitStamps: InlineGitStamp[] = [];
	const modelList = input.models;
	const contextWindowOf = (provider: string | undefined, model: string | undefined): number | undefined => {
		if (!model) return undefined;
		const m = modelList.find((x) => x.id === model && (provider ? x.provider === provider : true));
		return m?.contextWindow && m.contextWindow > 0 ? m.contextWindow : undefined;
	};

	// Sorted ascending seal timestamps of assistant messages across ALL
	// branches (not just the leaf path). A user turn's "thought for" anchors
	// on the most recent assistant completion in wall-clock — so re-editing
	// history message A into A0 (a fork whose leaf-path predecessor is
	// absent) still anchors on the old branch's leaf assistant, not nothing.
	const asstSeals: string[] = [];
	for (const id in doc.entries) {
		const e = doc.entries[id];
		if (e.kind === "message" && e.role === "assistant" && e.timestamp) asstSeals.push(e.timestamp);
	}
	asstSeals.sort();

	const flushPending = () => {
		if (pending.length === 0) return;
		// Context usage: report the entry's usage reading on the turn that
		// STARTS at block 0 of the entry — the turn's first entry — one reading
		// per turn. The entry's usage is "what the model saw when generating
		// that response". Invalid usage (aborted/error stop, all-zero) is
		// skipped, matching pi's compaction skip rule.
		const firstRef = pending[0];
		const reportsUsage = firstRef.blockIndex === 0;
		let contextPercent: number | undefined;
		let contextDeltaPercent: number | undefined;
		if (reportsUsage) {
			const e = firstRef.entry;
			const usage = validUsage(e);
			const window = usage ? contextWindowOf(e.provider, e.model) : undefined;
			if (usage && window) {
				contextPercent = ((usage.input + usage.cacheRead + usage.cacheWrite) / window) * 100;
				const prev = prevReading;
				const sameModel = prev !== null && e.model !== undefined && prev.model === e.model;
				const delta = contextPercent - (sameModel && prev ? prev.percent : contextPercent);
				// Display threshold: |delta| < 1pp is noise; a negative delta
				// (compaction drop) always renders — it marks the boundary.
				if (delta <= -0.5 || delta >= 0.95) contextDeltaPercent = delta;
				prevReading = { percent: contextPercent, model: e.model ?? "" };
			} else {
				prevReading = null; // unknown window / invalid usage breaks the delta chain
			}
		}
		const t = buildAssistantTurn(
			pending,
			turns.length,
			toolResultMap,
			prevTurns,
			prevBlocks,
			pendingAnchor,
			{
				contextPercent,
				contextDeltaPercent,
			},
			pendingGitStamps,
		);
		turns.push(t);
		pending = [];
		pendingGitStamps = [];
	};

	for (const entry of path) {
		switch (entry.kind) {
			case "message":
				if (entry.role === "assistant") {
					flushSwitchTurn();
					// All blocks accumulate into the pending turn — text does not
					// split. Turn evolution stays append-only by construction: a
					// turn is keyed by its first block and only ever grows until
					// a non-assistant entry flushes it. stopReason/errorMessage
					// ride the turn-closing turn (its last ref is the entry's last
					// block), so an error line renders once per turn.
					for (let i = 0; i < entry.content.length; i++) {
						if (pending.length === 0) {
							pendingAnchor = i > 0 ? entry.timestamp : prevSealTs;
						}
						pending.push({ entry, blockIndex: i });
					}
					// Entry with no content blocks but an error/abort stop reason:
					// produce a block carrying the error message even though there
					// is nothing to render in the block stream. It merges into the
					// pending turn like any other entry; the next flush (user turn,
					// system turn, or turn end) emits it.
					if (entry.content.length === 0 && (entry.stopReason === "error" || entry.stopReason === "aborted")) {
						const synthetic: MessageEntry = { ...entry, content: [{ type: "text", text: "" }] };
						if (pending.length === 0) pendingAnchor = prevSealTs;
						pending.push({ entry: synthetic, blockIndex: 0 });
					}
				} else {
					flushSwitchTurn();
					flushPending();
					const t = buildUserTurn(
						entry,
						turns.length,
						doc.entries,
						prevTurns,
						asstSeals,
						carriedGit?.identity,
						carriedGit?.subject,
					);
					turns.push(t);
					// (prevSealTs is updated uniformly at the end of the loop body.)
				}
				break;
			case "compaction":
				flushSwitchTurn();
				flushPending();
				turns.push(buildSystemTurn(entry, turns.length, "compaction", entry.summary, prevTurns));
				break;
			case "branch_summary":
				flushSwitchTurn();
				flushPending();
				turns.push(buildSystemTurn(entry, turns.length, "branch_summary", entry.summary, prevTurns));
				break;
			case "bash_execution":
				// A user-initiated shell run (! command) — its own turn between
				// user/assistant turns, chronologically where it ran.
				flushSwitchTurn();
				flushPending();
				turns.push(buildUserBashTurn(entry, turns.length));
				break;
			case "model_change":
			case "thinking_level_change":
				flushPending();
				if (switchTurn === null) {
					switchTurn = { firstId: entry.id, provider: "", modelId: "", thinkingLevel: "" };
				}
				if (entry.kind === "model_change") {
					switchTurn.provider = entry.provider;
					switchTurn.modelId = entry.modelId;
				} else {
					switchTurn.thinkingLevel = entry.thinkingLevel;
				}
				break;
			default:
				// ADR 10: a valid git stamp updates the carried identity. Mid-turn
				// stamps (tool_end/turn_end while a turn is open) fold into the turn
				// — the turn does NOT split; the stamp rides the pending refs and
				// renders inside its action group. A prompt-anchored stamp renders
				// nothing on its own: its identity is the next user message's
				// header chip. Other boundary stamps (user_bash_end, or a turn
				// anchor with no open turn) render as standalone cards at their
				// path position, flushing the turn first so the order holds.
				if (entry.kind === "custom" && entry.customType === GIT_STAMP_CUSTOM_TYPE) {
					const stamp = parseGitStampEntry(entry);
					if (stamp) {
						const identity = { commit: stamp.commit, branch: stamp.branch };
						const subject = stamp.v === 2 ? stamp.commitSubject : null;
						if (pending.length > 0 && (stamp.anchor === "tool_end" || stamp.anchor === "turn_end")) {
							const last = pending[pending.length - 1]!;
							pendingGitStamps.push({
								entryId: entry.id,
								timestamp: entry.timestamp,
								identity,
								commitSubject: subject,
								anchor: stamp.anchor,
								isInitial: !seenGitStamp,
								afterBlockKey: `${last.entry.id}:b${last.blockIndex}`,
							});
						} else if (stamp.anchor !== "prompt") {
							flushSwitchTurn();
							flushPending();
							turns.push(buildGitChangeTurn(entry, turns.length, identity, stamp, !seenGitStamp, prevTurns));
						}
						carriedGit = { identity, subject };
						seenGitStamp = true;
					}
				}
				// tool_result (joined into ToolActionVM), label, session_info,
				// custom, custom_message — invisible; do not break the merge.
				break;
		}
		if (entry.timestamp) prevSealTs = entry.timestamp;
	}
	flushPending();
	flushSwitchTurn();

	return {
		turns,
		leafEntryId: viewLeaf,
		forkPointId: viewLeaf === null || viewLeaf === doc.status.leafId ? null : computeForkPoint(doc, viewLeaf),
		pathKey: leafPathKey(doc, viewLeaf),
		streamingKey: leafStreamingKey(doc, viewLeaf),
		textKey: leafTextKey(doc, viewLeaf),
	};
}

// ============================================================================
// View-leaf override (web peek)
// ============================================================================

/** Effective leaf for a projection: the override when it resolves to a known
 * entry, the live leaf otherwise. `null`/`undefined` override = follow live. */
function resolveViewLeaf(doc: Document, viewLeafId: string | null | undefined): string | null {
	if (viewLeafId === null || viewLeafId === undefined) return doc.status.leafId;
	return doc.entries[viewLeafId] ? viewLeafId : doc.status.leafId;
}

/** Deepest entry on both the live path and the rendered path — where a peek
 * diverged from live. Walks the live path into a set, then the rendered path
 * leaf→root; the first live hit is the deepest shared entry. */
function computeForkPoint(doc: Document, viewLeafId: string): string | null {
	const live = new Set<string>();
	let cursor = doc.status.leafId;
	while (cursor) {
		live.add(cursor);
		cursor = doc.entries[cursor]?.parentId ?? null;
	}
	cursor = viewLeafId;
	while (cursor) {
		if (live.has(cursor)) return cursor;
		cursor = doc.entries[cursor]?.parentId ?? null;
	}
	return null; // disjoint paths — impossible in one session tree, defensive
}

// ============================================================================
// Leaf-path projection
// ============================================================================

function projectLeafPath(doc: Document, viewLeafId?: string | null): Entry[] {
	const path: Entry[] = [];
	let cursor: string | null = resolveViewLeaf(doc, viewLeafId);
	while (cursor) {
		const entry = doc.entries[cursor];
		if (!entry) break;
		path.push(entry);
		cursor = entry.parentId;
	}
	path.reverse();
	return path;
}

// ============================================================================
// Leaf-path identity — single source of truth for the path-structure string.
// useViewModel (web client) uses it for the path portion of the VM cache
// key (pre-compute, to skip computeViewModel when nothing structural moved); ConversationArea reads the
// same value post-compute via vm.pathKey, avoiding a render-time getStore()
// reach-in and a second walk of the path.
// ============================================================================

/**
 * Structural identity of the leaf path: `pathIds::provCounts`.
 * - `pathIds` are leaf->root entry ids, stable across recomputations of the
 *   ViewModel, so key equality holds across recomputations.
 * - `provCounts` are content-block counts for `pending:` entries on the path;
 *   they change as streaming assistant messages append blocks.
 */
export function leafPathKey(doc: Document, viewLeafId?: string | null): string {
	const entries = doc.entries;
	const pathIds: string[] = [];
	let cursor: string | null = resolveViewLeaf(doc, viewLeafId);
	while (cursor) {
		const entry = entries[cursor];
		if (!entry) break;
		pathIds.push(cursor);
		cursor = entry.parentId;
	}
	const provCounts = pathIds
		.filter((id) => id.startsWith("pending:"))
		.map((id) => {
			const e = entries[id];
			return e && "content" in e && Array.isArray(e.content) ? e.content.length : 0;
		})
		.join(",");
	return `${pathIds.join("|")}::${provCounts}`;
}

/**
 * Content-delta identity of the leaf entry: per-block text/thinking field
 * lengths. Complements `leafPathKey` (block counts) by capturing intra-block
 * streaming growth — `text_delta` and `thinking_delta` patch a field within
 * an existing block, so the block count (and thus `pathKey`) is unchanged
 * even though content is actively streaming. `text` is wire-eager; `thinking`
 * is lazy but live-subscribed on in-flight entries. Tool arguments/results are
 * excluded so lazy pulls and expand toggles don't trip the auto-scroll.
 * The renderer gates this with `isStreaming` so completed-turn lazy pulls of
 * `thinking` (which also change this key) stay excluded.
 */
export function leafStreamingKey(doc: Document, viewLeafId?: string | null): string {
	const leafId = resolveViewLeaf(doc, viewLeafId);
	if (!leafId) return "";
	const entry = doc.entries[leafId];
	if (!entry || entry.kind !== "message") return "";
	return entry.content
		.map((b) => {
			if (b.type === "text") return `t${b.text.length}`;
			if (b.type === "thinking") return `k${(b.thinking ?? "").length}`;
			return "x"; // tool call — args stream via deltas but are lazy; height stays put
		})
		.join("|");
}

/**
 * Readable-text identity of the leaf path: per-entry text length for user and
 * assistant `text` blocks only — thinking, tool calls, and images are
 * excluded. Distinct from {@link leafPathKey} (fires on any new block,
 * including thinking/tool calls) and {@link leafStreamingKey} (fires on
 * thinking growth too).
 *
 * Walks leaf->root and joins `id:len` for entries that carry text, so a new
 * user message (id appears) and assistant text growth (len rises) both change
 * it. Entries with no text yet are omitted, so an assistant entry that opens
 * with a thinking or tool block does not change the key until its first text
 * block lands.
 */
export function leafTextKey(doc: Document, viewLeafId?: string | null): string {
	const parts: string[] = [];
	let cursor: string | null = resolveViewLeaf(doc, viewLeafId);
	while (cursor) {
		const entry = doc.entries[cursor];
		if (!entry) break;
		if (entry.kind === "message") {
			let len = 0;
			for (const block of entry.content) {
				if (block.type === "text") len += block.text.length;
			}
			if (len > 0) parts.push(`${entry.id}:${len}`);
		}
		cursor = entry.parentId;
	}
	return parts.join("|");
}

/**
 * Full cache key for the store→ViewModel projection (see useViewModel in
 * the web client): `leafPathKey` + `leafStreamingKey` (structural identity)
 * plus the status fields that gate re-projection on non-structural state
 * changes, and the two external inputs that are not part of the Document
 * (`scope` — the current session stem, so a session switch re-projects even
 * onto an identical document — and `pullTick`, so lazy-pull ingests
 * re-project). `viewLeafId` is the rendered-leaf override (web peek): it must
 * be in the key or a peek/un-peek over an unchanged document would hit a
 * stale cache entry. Keeping this beside leafPathKey/leafStreamingKey means a
 * new `Status` field that affects the projection gets added in one place, next
 * to the code that reads it, instead of in a hand-maintained list in a
 * component.
 */
export function viewModelCacheKey(
	doc: Document,
	scope: string | null,
	pullTick: number,
	viewLeafId?: string | null,
): string {
	const status = doc.status;
	return [
		leafPathKey(doc),
		leafStreamingKey(doc),
		status.name,
		`${status.model.provider}/${status.model.modelId}`,
		status.thinkingLevel,
		String(status.isStreaming),
		String(status.isCompacting),
		String(scope),
		String(pullTick),
		String(JSON.stringify(status.contextUsage)),
		// Normalized so null (explicit follow-live) and undefined (no override)
		// share one key — they resolve to the same projection. Entry ids are
		// never empty strings, so "" unambiguously means "following live".
		viewLeafId ?? "",
	].join("::");
}

// ============================================================================
// Structure pass — turn builders (with identity preservation)
// ============================================================================

/** Element-wise image comparison for VM reuse (data/mimeType are the only fields). */
function sameImages(a: ImageContent[], b: ImageContent[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((img, i) => img.data === b[i].data && img.mimeType === b[i].mimeType);
}

function buildUserTurn(
	entry: MessageEntry,
	index: number,
	entries: Record<string, Entry>,
	prevTurns: Map<string, TurnVM>,
	asstSeals: string[],
	gitIdentity?: GitIdentity,
	gitCommitSubject?: string | null,
): UserTurn {
	const text = entry.content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	const images = entry.content.filter((c): c is ImageContent => c.type === "image");
	const siblings = computeSiblings(entry, entries);

	// "Thought for" = wall-clock from the most recent ASSISTANT completion
	// (across all branches) to this send. Anchoring on the previous assistant
	// message — not the leaf-path predecessor — fixes re-edits: editing
	// history message A into A0 forks a branch whose leaf-path predecessor
	// is absent, yet the user's deliberation interval runs from the last
	// assistant reply they saw (the old branch's leaf, e.g. D), so the anchor
	// is A0 − D, not "nothing". Omitted when no assistant has completed
	// before this send (the first turn).
	let thoughtForMs: number | undefined;
	const i = lowerBound(asstSeals, entry.timestamp);
	if (i > 0) {
		const d = diffMs(entry.timestamp, asstSeals[i - 1]);
		if (d >= 0) thoughtForMs = d;
	}

	const turn: UserTurn = {
		kind: "user",
		entryId: entry.id,
		index,
		text,
		images,
		siblings: siblings.ids,
		currentSiblingIndex: siblings.currentIndex,
		timestamp: entry.timestamp,
		thoughtForMs,
		gitIdentity,
		gitCommitSubject,
	};

	const prev = prevTurns.get(`user:${entry.id}`);
	if (prev?.kind === "user" && sameImages(prev.images, images)) {
		// Reuse the previous array so VM object identity is stable across recomputes.
		turn.images = prev.images;
	}
	if (
		prev &&
		prev.kind === "user" &&
		prev.index === turn.index &&
		prev.text === turn.text &&
		prev.images === turn.images &&
		prev.timestamp === turn.timestamp &&
		prev.currentSiblingIndex === turn.currentSiblingIndex &&
		prev.thoughtForMs === turn.thoughtForMs &&
		sameStringArray(prev.siblings, turn.siblings) &&
		prev.gitCommitSubject === turn.gitCommitSubject &&
		((prev.gitIdentity === undefined && gitIdentity === undefined) ||
			(prev.gitIdentity !== undefined &&
				gitIdentity !== undefined &&
				sameGitIdentity(prev.gitIdentity, gitIdentity)))
	) {
		return prev;
	}
	return turn;
}

/** One accumulated assistant content block: its owning entry and index.
 *  A turn is a list of these. */
interface BlockRef {
	entry: MessageEntry;
	blockIndex: number;
}

/** Usage valid for context accounting. Mirrors pi's compaction skip rule
 *  (compaction.ts): aborted/error stops and all-zero usage are untrustworthy. */
function validUsage(e: MessageEntry): Usage | null {
	if (e.stopReason === "aborted" || e.stopReason === "error") return null;
	const u = e.usage;
	if (!u) return null;
	if (u.input === 0 && u.output === 0 && u.cacheRead === 0 && u.cacheWrite === 0) return null;
	return u;
}

// ============================================================================
// Provider error parsing — recover a structured error from the
// `"<status>: {json}"` string pi-ai composes from provider HTTP errors.
// ============================================================================

export interface ParsedProviderError {
	/** HTTP status when the string carried a `<status>:` prefix (e.g. 400). */
	status?: number;
	/** Human-readable error text — the raw `errorMessage` when parsing fails. */
	message: string;
	/** Remaining JSON fields (code, param, type, ...) as loose KV. */
	attrs: Record<string, string>;
}

/**
 * Parse an error string shaped `"<status>: {json}"` (with optional provider
 * prefix, `"<prefix> (<status>): {json}"`). `json.message` becomes the
 * semantic `message`; every other JSON field lands in `attrs`. Any string that
 * does not parse (plain message, truncated JSON, trailing non-JSON lines)
 * yields `{ message: raw, attrs: {} }` — the raw string is the final fallback.
 */
export function parseProviderError(errorMessage: string): ParsedProviderError {
	const fallback: ParsedProviderError = { message: errorMessage, attrs: {} };
	const match = /^(?:.*?\((\d{3})\)|(\d{3})):\s*(\{)/.exec(errorMessage);
	if (!match) return fallback;
	const openBrace = match.index + match[0].length - 1;
	const json = scanJsonObject(errorMessage, openBrace);
	if (json === null) return fallback;
	try {
		const parsed: unknown = JSON.parse(json);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fallback;
		const record = parsed as Record<string, unknown>;
		// OpenAI-standard errors nest the payload under `error`; Volcengine-style
		// gateways return it flat. Unwrap the nested shape so both parse.
		const payload =
			typeof record.error === "object" &&
			record.error !== null &&
			!Array.isArray(record.error) &&
			typeof (record.error as Record<string, unknown>).message === "string"
				? (record.error as Record<string, unknown>)
				: record;
		const message = typeof payload.message === "string" ? payload.message.trim() : "";
		if (message.length === 0) return fallback;
		const attrs: Record<string, string> = {};
		for (const [key, value] of Object.entries(payload)) {
			if (key === "message" || value === undefined) continue;
			attrs[key] = typeof value === "string" ? value : JSON.stringify(value);
		}
		return { status: Number(match[1] ?? match[2]), message, attrs };
	} catch {
		return fallback;
	}
}

/**
 * Scan for the JSON object starting at `start` (the first `{`), tracking
 * string literals (escapes included) so braces inside values do not end the
 * object early. Returns the object text or null when no matching `}` exists.
 */
function scanJsonObject(text: string, start: number): string | null {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

function buildAssistantTurn(
	refs: BlockRef[],
	index: number,
	toolResultMap: Map<string, ToolResultEntry>,
	prevTurns: Map<string, TurnVM>,
	prevBlocks: Map<string, AssistantBlockVM>,
	turnStartedAt: string,
	context: { contextPercent?: number; contextDeltaPercent?: number },
	gitChanges: InlineGitStamp[] = [],
): AssistantTurn {
	// Flatten pass: one descriptor per accumulated block ref, in order.
	const blocks: AssistantBlockVM[] = [];
	for (const { entry, blockIndex } of refs) {
		const isProvisional = entry.id.startsWith("pending:");
		const vm = buildBlockVM(entry.id, blockIndex, entry.content[blockIndex], isProvisional, toolResultMap);
		if (vm) blocks.push(reuseBlock(prevBlocks, vm));
	}

	const last = refs[refs.length - 1].entry;
	// Display timestamp: the last *sealed* entry among the refs. A turn's
	// refs are contiguous, and entries seal in order, so the newest sealed
	// entry is the last ref's entry with a timestamp; using it directly
	// would toggle the header time off while a provisional entry streams
	// last (the MsgTime flicker during streaming).
	let displayTimestamp = "";
	for (let i = refs.length - 1; i >= 0; i--) {
		if (refs[i].entry.timestamp) {
			displayTimestamp = refs[i].entry.timestamp;
			break;
		}
	}
	// The turn is sealed iff its last ref's entry carries a real seal
	// timestamp — entries seal in order, so a provisional last entry means
	// the turn is still streaming. Until then the renderer shows a live
	// Date.now()-based total; totalMs/toolMs resolve only at seal.
	const sealed = !!last.timestamp;
	// Turn window end: a turn's tool calls execute AFTER their entry seals, so
	// the window extends to the latest sealed tool result — the per-turn
	// windows then partition the whole turn (the next turn anchors on this
	// turn's last tool seal, so tool time is counted once, in the turn that
	// issued the calls). A tool call with no sealed result yet (running, or
	// arguments still streaming) keeps the totals undefined.
	let endTs = last.timestamp;
	let toolsPending = false;
	for (const { entry, blockIndex } of refs) {
		const block = entry.content[blockIndex];
		if (block.type === "toolCall") {
			const tr = toolResultMap.get(block.id);
			if (!tr || !tr.timestamp) toolsPending = true;
			else if (tr.timestamp > endTs) endTs = tr.timestamp;
		}
	}
	const resolved = sealed && !toolsPending;
	let totalMs: number | undefined;
	let toolMs: number | undefined;
	if (resolved && turnStartedAt) {
		const t = diffMs(endTs, turnStartedAt);
		if (t >= 0) totalMs = t;
		toolMs = computeToolMs(refs, toolResultMap, turnStartedAt, endTs);
	}

	const first = refs[0];
	const turn: AssistantTurn = {
		kind: "assistant",
		// entryId = the first entry of the turn — App.tsx lookups
		// (focus/navigation) match the FIRST turn of an entry.
		entryId: first.entry.id,
		turnKey: first.blockIndex === 0 ? first.entry.id : `${first.entry.id}:b${first.blockIndex}`,
		index,
		blocks,
		model: last.model,
		provider: last.provider,
		usage: last.usage,
		// stopReason/errorMessage only when the turn's last ref is its entry's
		// last block (always true for turn-merged turns): an error/abort line
		// renders once per turn, never per sub-turn.
		stopReason: refs[refs.length - 1].blockIndex === last.content.length - 1 ? last.stopReason : undefined,
		errorMessage:
			refs[refs.length - 1].blockIndex === last.content.length - 1 ? (last.errorMessage ?? undefined) : undefined,
		parsedError:
			refs[refs.length - 1].blockIndex === last.content.length - 1 && last.errorMessage
				? parseProviderError(last.errorMessage)
				: undefined,
		timestamp: displayTimestamp,
		turnStartedAt: turnStartedAt || undefined,
		totalMs,
		toolMs,
		contextPercent: context.contextPercent,
		contextDeltaPercent: context.contextDeltaPercent,
		gitChanges: gitChanges.length > 0 ? gitChanges : undefined,
	};

	const prev = prevTurns.get(`assistant:${turn.turnKey}`);
	if (
		prev &&
		prev.kind === "assistant" &&
		prev.index === turn.index &&
		prev.model === turn.model &&
		prev.provider === turn.provider &&
		prev.usage === turn.usage &&
		prev.stopReason === turn.stopReason &&
		prev.errorMessage === turn.errorMessage &&
		prev.timestamp === turn.timestamp &&
		prev.turnStartedAt === turn.turnStartedAt &&
		prev.totalMs === turn.totalMs &&
		prev.toolMs === turn.toolMs &&
		prev.contextPercent === turn.contextPercent &&
		prev.contextDeltaPercent === turn.contextDeltaPercent &&
		sameGitStamps(prev.gitChanges, turn.gitChanges) &&
		prev.blocks.length === turn.blocks.length &&
		prev.blocks.every((b, i) => b === turn.blocks[i])
	) {
		return prev;
	}
	return turn;
}

/** Element-wise comparison for AssistantTurn.gitChanges reuse. */
function sameGitStamps(a: InlineGitStamp[] | undefined, b: InlineGitStamp[] | undefined): boolean {
	if (a === b) return true;
	if (!a || !b || a.length !== b.length) return false;
	return a.every((m, i) => {
		const o = b[i]!;
		return (
			m.entryId === o.entryId &&
			m.timestamp === o.timestamp &&
			m.commitSubject === o.commitSubject &&
			m.anchor === o.anchor &&
			m.isInitial === o.isInitial &&
			m.afterBlockKey === o.afterBlockKey &&
			sameGitIdentity(m.identity, o.identity)
		);
	});
}

function buildGitChangeTurn(
	entry: Entry,
	index: number,
	identity: GitIdentity,
	stamp: NonNullable<ReturnType<typeof parseGitStampEntry>>,
	isInitial: boolean,
	prevTurns: Map<string, TurnVM>,
): GitChangeTurn {
	const turn: GitChangeTurn = {
		kind: "gitChange",
		entryId: entry.id,
		index,
		timestamp: entry.timestamp,
		identity,
		commitSubject: stamp.v === 2 ? stamp.commitSubject : null,
		anchor: stamp.anchor,
		isInitial,
	};
	const prev = prevTurns.get(`gitChange:${entry.id}`);
	if (
		prev &&
		prev.kind === "gitChange" &&
		prev.index === turn.index &&
		prev.timestamp === turn.timestamp &&
		prev.commitSubject === turn.commitSubject &&
		prev.anchor === turn.anchor &&
		prev.isInitial === turn.isInitial &&
		sameGitIdentity(prev.identity, identity)
	) {
		return prev;
	}
	return turn;
}

function buildUserBashTurn(entry: BashExecutionEntry, index: number): UserBashTurn {
	return {
		kind: "userBash",
		entryId: entry.id,
		index,
		timestamp: entry.timestamp,
		command: entry.command,
		output: entry.output,
		exitCode: entry.exitCode,
		cancelled: entry.cancelled,
		truncated: entry.truncated,
		fullOutputPath: entry.fullOutputPath,
		excludeFromContext: entry.excludeFromContext,
	};
}

function buildSystemTurn(
	entry: Entry,
	index: number,
	type: "compaction" | "branch_summary",
	summary: string | undefined,
	prevTurns: Map<string, TurnVM>,
): SystemTurn {
	const turn: SystemTurn = { kind: "system", type, entryId: entry.id, index, summary };
	const prev = prevTurns.get(`system:${entry.id}`);
	if (
		prev &&
		prev.kind === "system" &&
		prev.type === turn.type &&
		prev.index === turn.index &&
		prev.summary === turn.summary
	) {
		return prev;
	}
	return turn;
}

function buildSwitchTurn(
	switchData: { firstId: string; provider: string; modelId: string; thinkingLevel: string },
	index: number,
	prevTurns: Map<string, TurnVM>,
): SystemTurn {
	const switchTo = {
		provider: switchData.provider,
		modelId: switchData.modelId,
		thinkingLevel: switchData.thinkingLevel !== "" ? switchData.thinkingLevel : undefined,
	};
	const turn: SystemTurn = { kind: "system", type: "model_switch", entryId: switchData.firstId, index, switchTo };
	// Keyed by the turn's first entry id: when the turn extends (a new entry
	// appended to the doc), the key is stable but switchTo differs, so the
	// dedup still yields a fresh turn.
	const prev = prevTurns.get(`system:${switchData.firstId}`);
	if (prev?.kind === "system" && prev.type === "model_switch" && prev.index === turn.index && prev.switchTo) {
		const p = prev.switchTo;
		if (
			p.provider === switchTo.provider &&
			p.modelId === switchTo.modelId &&
			p.thinkingLevel === switchTo.thinkingLevel
		) {
			return prev;
		}
	}
	return turn;
}

// ============================================================================
// Flatten pass — block VM construction
// ============================================================================

function buildBlockVM(
	entryId: string,
	blockIndex: number,
	block: Content,
	isProvisional: boolean,
	toolResultMap: Map<string, ToolResultEntry>,
): AssistantBlockVM | null {
	switch (block.type) {
		case "text":
			return { blockType: "text", entryId, blockIndex, text: block.text, isProvisional };
		case "thinking":
			return {
				blockType: "thinking",
				entryId,
				blockIndex,
				thinking: block.thinking,
				isProvisional,
				redacted: block.redacted === true,
			};
		case "toolCall": {
			const resultEntry = toolResultMap.get(block.id) ?? null;
			const result: ToolResultSnapshot | null = resultEntry
				? { entryId: resultEntry.id, isError: resultEntry.isError }
				: null;
			let status: ToolActionVM["status"];
			if (resultEntry) {
				// A provisional result entry (pending: prefix) is created at
				// tool_execution_start and lives until tool_execution_end seals
				// it to a durable id — so provisional means the tool is running,
				// not done.
				if (resultEntry.id.startsWith("pending:")) {
					status = "running";
				} else {
					status = resultEntry.isError ? "error" : "done";
				}
			} else {
				// "running" = arguments present (tool dispatched) but no result yet.
				status = block.arguments !== null ? "running" : "pending";
			}
			return {
				blockType: "tool",
				entryId,
				blockIndex,
				toolName: block.name,
				toolCallId: block.id,
				arguments: block.arguments,
				result,
				summary: buildActionSummary(block),
				status,
			};
		}
		default:
			// image — not rendered in v1
			return null;
	}
}

/** Reuse the previous block VM object when all derived fields are unchanged. */
function reuseBlock(prevBlocks: Map<string, AssistantBlockVM>, vm: AssistantBlockVM): AssistantBlockVM {
	const prev = prevBlocks.get(`${vm.entryId}:${vm.blockIndex}`);
	if (!prev || prev.blockType !== vm.blockType) return vm;
	switch (vm.blockType) {
		case "text": {
			const p = prev as TextBlockVM;
			return p.text === vm.text && p.isProvisional === vm.isProvisional ? p : vm;
		}
		case "thinking": {
			const p = prev as ThinkActionVM;
			return p.thinking === vm.thinking && p.isProvisional === vm.isProvisional && p.redacted === vm.redacted
				? p
				: vm;
		}
		case "tool": {
			const p = prev as ToolActionVM;
			const sameResult =
				p.result === vm.result ||
				(p.result !== null &&
					vm.result !== null &&
					p.result.entryId === vm.result.entryId &&
					p.result.isError === vm.result.isError);
			return p.toolName === vm.toolName &&
				p.toolCallId === vm.toolCallId &&
				p.arguments === vm.arguments &&
				p.summary === vm.summary &&
				p.status === vm.status &&
				sameResult
				? p
				: vm;
		}
	}
}

// ============================================================================
// Tool result map
// ============================================================================

function buildToolResultMap(entries: Record<string, Entry>): Map<string, ToolResultEntry> {
	const map = new Map<string, ToolResultEntry>();
	for (const entry of Object.values(entries)) {
		if (entry.kind === "tool_result") {
			map.set(entry.toolCallId, entry);
		}
	}
	return map;
}

// ============================================================================
// Action summaries
// ============================================================================

/** Abnormal stop reasons that break assistant-turn merging and get rendered as errors. */
/**
 * Build a human-readable summary for a tool call, given its name and arguments.
 * Exported so the web UI can use it with live (store-direct) argument data
 * instead of relying on the (possibly stale) ViewModel snapshot.
 */
export function displayPath(rawPath: string, cwd: string | null): string {
	if (cwd && rawPath.startsWith(cwd)) {
		const relative = rawPath.slice(cwd.length);
		return relative.startsWith("/") ? relative.slice(1) : relative;
	}
	return rawPath;
}

/** Resource files that get a compact "read resource" summary (TUI parity). */
const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

interface CompactReadClass {
	kind: "skill" | "resource";
	label: string;
}

/**
 * Compact classification for reads (TUI parity): SKILL.md files summarize as
 * their skill folder; agent-resource files (AGENTS.md, CLAUDE.md, …) as
 * "read resource <path>". The TUI's pi-docs classification (README.md/
 * docs/* under pi's own package root) needs daemon-side knowledge of the
 * installation path and is deferred until that rides the wire.
 */
function classifyReadPath(rawPath: string, cwd: string): CompactReadClass | null {
	const abs = rawPath.startsWith("/") ? rawPath : `${cwd.replace(/\/$/, "")}/${rawPath}`;
	const parts = abs.split("/");
	const fileName = parts[parts.length - 1] || rawPath;
	if (fileName === "SKILL.md") {
		return { kind: "skill", label: parts[parts.length - 2] || fileName };
	}
	if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
		return { kind: "resource", label: displayPath(abs, cwd) };
	}
	return null;
}

/**
 * Build a human-readable summary for a tool call, given its name and arguments.
 * Exported so the web UI can use it with live (store-direct) argument data
 * instead of relying on the (possibly stale) ViewModel snapshot.
 * @param cwd - optional instance cwd to produce project-relative paths
 */
export function makeActionSummary(name: string, args: JsonValue | null, cwd?: string | null): string {
	const recArgs: Record<string, unknown> | null =
		args !== null && typeof args === "object" ? (args as Record<string, unknown>) : null;

	switch (name) {
		case "read": {
			const path = recArgs ? ((recArgs.path as string) ?? (recArgs.filePath as string)) : null;
			const display = path && cwd ? path.split("/").pop() || path : path;
			const offset = recArgs ? (recArgs.offset as number | undefined) : undefined;
			const limit = recArgs ? (recArgs.limit as number | undefined) : undefined;
			const lineRange =
				offset !== undefined ? ` L${offset}${limit !== undefined ? `-${offset + limit - 1}` : ""}` : "";
			if (path && cwd) {
				const cls = classifyReadPath(path, cwd);
				if (cls) {
					return cls.kind === "skill"
						? `[skill] ${cls.label}${lineRange}`
						: `read ${cls.kind} ${cls.label}${lineRange}`;
				}
			}
			return display ? `${name}: ${display}${lineRange}` : name;
		}
		case "edit":
		case "write": {
			const path = recArgs ? ((recArgs.path as string) ?? (recArgs.filePath as string)) : null;
			const display = path && cwd ? path.split("/").pop() || path : path;
			return display ? `${name}: ${display}` : name;
		}
		case "bash":
		case "powershell": {
			const cmd = recArgs ? (recArgs.command as string) : null;
			return cmd ? `${name}: ${cmd}` : name;
		}
		case "apply_patch": {
			const input = applyPatchInput(args);
			const paths = input !== null ? extractApplyPatchPaths(input) : [];
			if (paths.length === 0) return name;
			const first = paths[0].split("/").pop() || paths[0];
			return paths.length === 1 ? `patch: ${first}` : `patch: ${first} +${paths.length - 1}`;
		}
		case "glob": {
			const pattern = recArgs ? (recArgs.pattern as string) : null;
			return pattern ? `glob: ${pattern}` : "glob";
		}
		case "grep": {
			const query = recArgs ? ((recArgs.query as string) ?? (recArgs.pattern as string)) : null;
			return query ? `grep: ${query}` : "grep";
		}
		default: {
			// First argument value, truncated
			if (recArgs) {
				const firstVal = Object.values(recArgs)[0];
				if (typeof firstVal === "string") {
					return firstVal.length > 60 ? `${name} ${firstVal.slice(0, 57)}...` : `${name} ${firstVal}`;
				}
			}
			return name;
		}
	}
}

function buildActionSummary(block: ToolCallBlock): string {
	return makeActionSummary(block.name, block.arguments);
}

// ---------------------------------------------------------------------------
// Beautified shell command — the collapsed bash action renders the command
// with two decorations (rendered as spans by the web layer): command words
// ("npm run", "git commit") as tinted chips, and abbreviated tokens as
// dimmed italic text (the title carries the original). Purely cosmetic:
// the raw command stays the data model, and the expanded card's header
// line shows it unmodified.
//
// Front-end: a quote-aware piece scanner (scanShellPieces) — NOT a shell
// parser. It tracks '…'/"…"/backslash escapes and unquoted &&/;/|/||, the
// minimum context the decoration rules need to stay out of quoted strings
// ('rg "foo|bar"' must not chip foo/bar). Consciously untracked: $(…),
// backticks, heredocs — rare in agent one-liners, cosmetic failure mode.
// The piece stream is the seam where a real token source (e.g. Shiki's
// bash grammar) could slot in later.
//
// Rules (deliberately ad-hoc heuristics over pieces):
//   1. a leading "cd <dir> <sep>" is elided by its relation to the cwd (under
//      it → cwd-relative chip; equal to it → no-op "cd;" chip; outside it
//      → elided-prefix chip keeping the last two segments);
//   2. any path-shaped word (absolute or ./ ../-prefixed) with more than
//      two real segments is elided to its last two ("/a/b/c/d.ts" →
//      "...c/d.ts"; "../.." never leaks beside a "..." label);
//   3. the first command of every separated segment gets a chip — words
//      containing "=" (env assignments) don't count and keep the
//      expectation alive ("FOO=1 npm test" chips npm) — plus its
//      subcommand when the parent is a known multi-word tool (npm, git,
//      cargo, docker, …). Boring text/file utilities (ls, head, tail, rg,
//      sed, cat, …) end the expectation without a chip.
// ---------------------------------------------------------------------------

/** One piece of a beautified shell command: literal text, a highlighted
 * command word, or an elided token (shortened label + the original for the
 * hover title). */
export type ShellCommandSegment =
	| { kind: "text"; text: string }
	| { kind: "cmd"; text: string }
	| { kind: "elide"; label: string; original: string };

/** Scanner output: an unquoted word, a whole quoted span (quotes included,
 * never decorated inside), an unquoted command separator, or whitespace. */
export interface ShellPiece {
	kind: "word" | "quoted" | "sep" | "other";
	text: string;
}

/**
 * Split a shell command into quote-aware pieces. Single-quoted spans have
 * no escapes (shell truth); double-quoted spans honor backslash escapes;
 * outside quotes a backslash joins the following character to the word
 * (escaped spaces stay in the word). "|" and ";" always separate unquoted;
 * "&" separates only doubled ("&&") — a lone "&" is a word character
 * ("2>&1"). Unterminated quotes run to the end of the string. Adjacent
 * same-kind runs merge, so concatenating all piece texts round-trips the
 * input exactly.
 */
export function scanShellPieces(text: string): ShellPiece[] {
	const pieces: ShellPiece[] = [];
	const push = (kind: ShellPiece["kind"], t: string) => {
		if (t.length === 0) return;
		const prev = pieces[pieces.length - 1];
		if (prev !== undefined && prev.kind === kind) prev.text += t;
		else pieces.push({ kind, text: t });
	};
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (/\s/.test(c)) {
			let j = i + 1;
			while (j < text.length && /\s/.test(text[j])) j++;
			push("other", text.slice(i, j));
			i = j;
			continue;
		}
		if (c === "'" || c === '"') {
			let j = i + 1;
			while (j < text.length) {
				if (c === '"' && text[j] === "\\") {
					j += 2;
					continue;
				}
				if (text[j] === c) break;
				j++;
			}
			const end = Math.min(j + 1, text.length); // include the closing quote when found
			push("quoted", text.slice(i, end));
			i = end;
			continue;
		}
		if (c === ";" || c === "|" || (c === "&" && text[i + 1] === "&")) {
			const doubled = (c === "|" || c === "&") && text[i + 1] === c;
			push("sep", text.slice(i, i + (doubled ? 2 : 1)));
			i += doubled ? 2 : 1;
			continue;
		}
		let j = i;
		while (j < text.length) {
			const d = text[j];
			if (/\s/.test(d) || d === "'" || d === '"' || d === ";" || d === "|") break;
			if (d === "&" && text[j + 1] === "&") break;
			if (d === "\\" && j + 1 < text.length) {
				j += 2;
				continue;
			}
			j++;
		}
		push("word", text.slice(i, j));
		i = j;
	}
	return pieces;
}

/** Elide a shell command into display segments. A command nothing applies
 * to yields a single text segment — callers can treat a one-text result as
 * "no decoration needed". */
export function beautifyShellCommand(command: string, cwd?: string | null): ShellCommandSegment[] {
	const pieces = scanShellPieces(command);
	const out: ShellCommandSegment[] = [];
	const pushText = (t: string) => {
		if (t.length === 0) return;
		const prev = out[out.length - 1];
		if (prev?.kind === "text") prev.text += t;
		else out.push({ kind: "text", text: t });
	};
	const textOf = (from: number, to: number) =>
		pieces
			.slice(from, to)
			.map((p) => p.text)
			.join("");
	// First non-whitespace piece at or after `from`; -1 when none.
	const nextNonOther = (from: number): number => {
		for (let k = from; k < pieces.length; k++) if (pieces[k].kind !== "other") return k;
		return -1;
	};

	let idx = 0;

	// Rule 1: leading "cd <dir> <sep>" — three shapes:
	//   dir under cwd   → one chip "cd <relative>" (the separator is elided);
	//   dir is the cwd  → one chip "cd;" — a no-op cd, nothing to show;
	//   dir outside cwd → "cd" and the separator stay plain text; a deep dir
	//                     elides its prefix to a "…" chip with the last two
	//                     segments as plain text (a shallow dir stays raw —
	//                     eliding "/" would be decoration without gain).
	// In every shape the dir is consumed here, so rule 2 never re-elides it.
	if (pieces[0]?.kind === "word" && pieces[0].text === "cd") {
		const dirIdx = nextNonOther(1);
		const sepIdx = dirIdx >= 0 ? nextNonOther(dirIdx + 1) : -1;
		if (dirIdx >= 0 && sepIdx >= 0 && pieces[dirIdx]?.kind === "word" && pieces[sepIdx]?.kind === "sep") {
			const dir = pieces[dirIdx].text;
			const relative = displayPath(dir, cwd ?? null);
			if (relative !== dir) {
				out.push({
					kind: "elide",
					label: relative.length > 0 ? `cd ${relative}` : "cd;",
					original: textOf(0, sepIdx + 1),
				});
				idx = sepIdx + 1;
			} else {
				// Real segments only — ".."/"." are not content; a dir without
				// two real trailing segments stays raw.
				const parts = dir.split("/").filter((p) => p !== "" && p !== "." && p !== "..");
				const tail = parts.length > 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : null;
				const elided = tail !== null ? dir.slice(0, dir.length - tail.length) : "";
				if (tail !== null && elided.length > 1) {
					pushText(textOf(0, dirIdx)); // "cd "
					out.push({ kind: "elide", label: "…", original: dir });
					pushText(tail);
					pushText(textOf(dirIdx + 1, sepIdx + 1)); // " &&"
					idx = sepIdx + 1;
				}
			}
		}
	}

	// Rules 2+3 over the remaining pieces. `expectCommand` is true at the
	// start and after every separator; an env-assignment word ("FOO=1")
	// keeps it alive, any other word ends it (boring commands included).
	let expectCommand = true;
	while (idx < pieces.length) {
		const p = pieces[idx];
		if (p === undefined) break;
		if (p.kind === "sep") {
			pushText(p.text);
			expectCommand = true;
			idx++;
			continue;
		}
		if (p.kind !== "word") {
			pushText(p.text);
			idx++;
			continue;
		}
		const word = p.text;

		// Rule 2: path-shaped words elide to their last two real segments.
		const elided = elidePathWord(word);
		if (elided !== null) {
			out.push(elided);
			expectCommand = false;
			idx++;
			continue;
		}

		if (expectCommand) {
			if (word.includes("=")) {
				// env assignment — the real command is still coming
				pushText(word);
				idx++;
				continue;
			}
			expectCommand = false;
			if (WORD.test(word) && !BORING_COMMANDS.has(word)) {
				// Rule 3: chip the command word; a known parent also chips its
				// subcommand ("npm run", "git commit") when the next word is one.
				const wsIdx = idx + 1;
				const subIdx = idx + 2;
				if (
					SUBCOMMAND_PARENTS.has(word) &&
					pieces[wsIdx]?.kind === "other" &&
					pieces[subIdx]?.kind === "word" &&
					SUB_WORD.test(pieces[subIdx].text)
				) {
					out.push({ kind: "cmd", text: `${word}${pieces[wsIdx].text}${pieces[subIdx].text}` });
					idx = subIdx + 1;
				} else {
					out.push({ kind: "cmd", text: word });
					idx++;
				}
				continue;
			}
		}
		pushText(word);
		idx++;
	}
	return out;
}

/** Rule 2 helper — elide a path-shaped word ("/a/b/c/d.ts", "./x/y.ts",
 * "../../x/y.ts") with more than two real segments to its last two. */
function elidePathWord(word: string): ShellCommandSegment | null {
	if (!word.startsWith("/") && !word.startsWith("./") && !word.startsWith("../")) return null;
	const parts = word.split("/").filter((p) => p !== "" && p !== "." && p !== "..");
	if (parts.length <= 2) return null;
	return {
		kind: "elide",
		label: `...${parts[parts.length - 2]}/${parts[parts.length - 1]}`,
		original: word,
	};
}

/** Text/file utilities that never get a command chip — they are the noise a
 * summary wants to de-emphasize, not the signal. */
const BORING_COMMANDS = new Set([
	"ls",
	"head",
	"tail",
	"rg",
	"sed",
	"cat",
	"echo",
	"cd",
	"pwd",
	"grep",
	"find",
	"fd",
	"wc",
	"sort",
	"uniq",
	"tr",
	"cut",
	"touch",
	"mkdir",
	"rmdir",
	"rm",
	"cp",
	"mv",
	"ln",
	"chmod",
	"chown",
	"du",
	"df",
	"ps",
	"kill",
	"which",
	"whereis",
	"file",
	"stat",
	"date",
	"whoami",
	"id",
	"env",
	"printenv",
	"export",
	"set",
	"unset",
	"source",
	"alias",
	"sleep",
	"true",
	"false",
	"test",
	"xargs",
	"tee",
	"less",
	"more",
	"diff",
	"cmp",
	"md5sum",
	"sha256sum",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"seq",
	"nl",
	"tac",
	"awk",
	"vim",
	"nvim",
	"nano",
]);

/** Tools whose first argument is a subcommand worth sharing the chip
 * ("npm run", "git commit", "docker compose"). */
const SUBCOMMAND_PARENTS = new Set([
	"git",
	"npm",
	"pnpm",
	"yarn",
	"bun",
	"deno",
	"cargo",
	"docker",
	"kubectl",
	"helm",
	"terraform",
	"pip",
	"pip3",
	"uv",
	"go",
	"brew",
	"apt",
	"apt-get",
	"dnf",
	"yum",
	"systemctl",
	"aws",
	"gcloud",
	"az",
	"dotnet",
	"composer",
	"poetry",
	"gem",
	"pi",
]);

const WORD = /^[A-Za-z][\w.-]*$/;
const SUB_WORD = /^[A-Za-z][\w-]*$/;

/**
 * The full-form identifier for a tool call — the counterpart of
 * makeActionSummary. The collapsed tinted row abbreviates for scannability
 * (basename, single line); the expanded card restores the full truth:
 * cwd-relative full paths (with the read line range), the entire bash
 * command (all lines). Not length-capped. Returns null while the
 * identifier argument has not streamed yet.
 */
export function makeActionHeader(name: string, args: JsonValue | null, cwd?: string | null): string | null {
	const recArgs: Record<string, unknown> | null =
		args !== null && typeof args === "object" ? (args as Record<string, unknown>) : null;

	switch (name) {
		case "read": {
			const path = recArgs ? ((recArgs.path as string) ?? (recArgs.filePath as string)) : null;
			if (!path) return null;
			const offset = recArgs ? (recArgs.offset as number | undefined) : undefined;
			const limit = recArgs ? (recArgs.limit as number | undefined) : undefined;
			const range = offset !== undefined ? `:${offset}${limit !== undefined ? `-${offset + limit - 1}` : ""}` : "";
			return `${displayPath(path, cwd ?? null)}${range}`;
		}
		case "edit":
		case "write": {
			const path = recArgs ? ((recArgs.path as string) ?? (recArgs.filePath as string)) : null;
			return path ? displayPath(path, cwd ?? null) : null;
		}
		case "bash":
		case "powershell": {
			const cmd = recArgs ? (recArgs.command as string) : null;
			return cmd ? cmd : null;
		}
		case "apply_patch": {
			const input = applyPatchInput(args);
			if (input === null) return null;
			const paths = extractApplyPatchPaths(input);
			if (paths.length === 0) return null;
			return paths.map((p) => displayPath(p, cwd ?? null)).join(", ");
		}
		case "grep": {
			const pattern = recArgs ? ((recArgs.pattern as string) ?? (recArgs.query as string)) : null;
			if (pattern === null || pattern === undefined) return null;
			const path = recArgs ? (recArgs.path as string | undefined) : undefined;
			const glob = recArgs ? (recArgs.glob as string | undefined) : undefined;
			const limit = recArgs ? (recArgs.limit as number | undefined) : undefined;
			let text = `/${pattern}/ in ${path ? displayPath(path, cwd ?? null) : "."}`;
			if (glob) text += ` (${glob})`;
			if (limit !== undefined) text += ` limit ${limit}`;
			return text;
		}
		case "find": {
			const pattern = recArgs ? (recArgs.pattern as string | undefined) : undefined;
			if (pattern === undefined || pattern === null) return null;
			const path = recArgs ? (recArgs.path as string | undefined) : undefined;
			const limit = recArgs ? (recArgs.limit as number | undefined) : undefined;
			let text = `${pattern} in ${path ? displayPath(path, cwd ?? null) : "."}`;
			if (limit !== undefined) text += ` limit ${limit}`;
			return text;
		}
		case "ls": {
			const path = recArgs ? (recArgs.path as string | undefined) : undefined;
			const limit = recArgs ? (recArgs.limit as number | undefined) : undefined;
			let text = `ls ${path ? displayPath(path, cwd ?? null) : "."}`;
			if (limit !== undefined) text += ` limit ${limit}`;
			return text;
		}
		default: {
			if (recArgs) {
				const firstVal = Object.values(recArgs)[0];
				if (typeof firstVal === "string" && firstVal) return firstVal;
			}
			return null;
		}
	}
}

// ============================================================================
// Sibling pager (user messages only)
// ============================================================================

function computeSiblings(entry: MessageEntry, entries: Record<string, Entry>): { ids: string[]; currentIndex: number } {
	const parentId = entry.parentId;
	const siblings: MessageEntry[] = [];

	for (const e of Object.values(entries)) {
		if (e.kind === "message" && e.role === "user" && e.parentId === parentId) {
			siblings.push(e);
		}
	}

	// Sort by timestamp
	siblings.sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));

	const ids = siblings.map((e) => e.id);
	const currentIndex = ids.indexOf(entry.id);
	return { ids, currentIndex: currentIndex >= 0 ? currentIndex : 0 };
}

function sameStringArray(a: string[] | undefined, b: string[] | undefined): boolean {
	if (a === b) return true;
	if (!a || !b || a.length !== b.length) return false;
	return a.every((v, i) => v === b[i]);
}

// ============================================================================
// Turn timing — pure helpers
// ============================================================================

/** Wall-clock ms between two ISO timestamps (end − start). NaN if either is
 * empty/invalid; the callers gate on that to omit the field. */
function diffMs(endIso: string, startIso: string): number {
	if (!endIso || !startIso) return Number.NaN;
	const end = new Date(endIso).getTime();
	const start = new Date(startIso).getTime();
	if (Number.isNaN(end) || Number.isNaN(start)) return Number.NaN;
	return end - start;
}

/** Index of the first element >= `x` in a sorted-ascending array (a standard
 * lower_bound). Returns `arr.length` if all elements are < x. ISO strings
 * with the fixed `…Z` toISOString format sort lexicographically =
 * chronologically, so this yields the wall-clock ordering. Used to find the
 * most recent assistant seal strictly before a user send: `arr[i-1]`. */
function lowerBound(arr: string[], x: string): number {
	let lo = 0;
	let hi = arr.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (arr[mid] < x) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** Time in tool execution across a sealed assistant turn.
 *
 * Computed as total − Σ(assistant-generation windows), so parallel tools are
 * handled correctly: each batch's tool window is the wall-clock span from the
 * calling assistant message's seal to the LAST parallel result's seal (the
 * max), not a per-tool sum. The generation windows telescope into the total
 * minus the inter-batch gaps, which are exactly the tool-execution spans.
 *
 * `trigger_1 = turnStartedAt` (the user send); `trigger_{k>1} = max toolResult
 * seal of batch k-1`. `gen_k = asst_k_seal − trigger_k`. A provisional entry
 * (no seal) aborts the walk and returns undefined — the turn is still
 * streaming, so the split can't resolve. */
function computeToolMs(
	refs: BlockRef[],
	toolResultMap: Map<string, ToolResultEntry>,
	turnStartedAt: string,
	endTs: string,
): number | undefined {
	if (!endTs) return undefined;
	const total = diffMs(endTs, turnStartedAt);
	if (Number.isNaN(total)) return undefined;

	// Group refs by entry (consecutive refs share an entry) and walk the
	// generation/tool chain: each entry's generation runs from the previous
	// chain point to its seal; the next chain point is the latest parallel
	// tool-result seal of that entry's tool calls in this turn.
	let triggerTs = turnStartedAt;
	let totalGen = 0;
	let i = 0;
	while (i < refs.length) {
		const entry = refs[i].entry;
		if (!entry.timestamp) return undefined; // provisional — can't resolve
		// Collect this entry's contiguous refs (may be a mid-entry slice).
		let j = i;
		let maxTool = "";
		while (j < refs.length && refs[j].entry === entry) {
			const block = entry.content[refs[j].blockIndex];
			if (block.type === "toolCall") {
				const tr = toolResultMap.get(block.id);
				if (tr?.timestamp && tr.timestamp > maxTool) maxTool = tr.timestamp;
			}
			j++;
		}
		const gen = diffMs(entry.timestamp, triggerTs);
		if (!Number.isNaN(gen) && gen > 0) totalGen += gen;
		// Next batch's trigger = the latest parallel result in THIS batch.
		// No tools → generation chains directly to the next entry's seal.
		triggerTs = maxTool || entry.timestamp;
		i = j;
	}
	const toolMs = total - totalGen;
	return toolMs >= 0 ? toolMs : undefined;
}

// ============================================================================
// Turn key — unique identity of a turn for focus/navigation/React keys.
// Assistant turns use turnKey (entryId — or entryId:b<index> if a turn ever
// starts mid-entry); user/system turns are one-per-entry, so their entryId
// is the key.
// ============================================================================

export function turnKeyOf(t: TurnVM): string {
	return t.kind === "assistant" ? t.turnKey : t.entryId;
}

// ============================================================================
// Newest-leaf walk — for variant pager navigation targets
// ============================================================================

/**
 * Given a user message entry id, find the newest leaf in its subtree.
 * DFS max-timestamp (string localeCompare), max-id tiebreak.
 */
export function newestLeafInSubtree(entryId: string, entries: Record<string, Entry>): string {
	const subtree = new Set<string>();
	const queue = [entryId];

	// BFS to collect all entries in the subtree
	while (queue.length > 0) {
		const id = queue.shift()!;
		if (subtree.has(id)) continue;
		subtree.add(id);

		for (const e of Object.values(entries)) {
			if (e.parentId === id && !subtree.has(e.id)) {
				queue.push(e.id);
			}
		}
	}

	// Find the leaf with the newest timestamp
	let newest: { id: string; timestamp: string } = { id: entryId, timestamp: "" };
	for (const id of subtree) {
		const e = entries[id];
		if (!e) continue;
		const ts = e.timestamp ?? "";
		if (ts > newest.timestamp || (ts === newest.timestamp && id > newest.id)) {
			newest = { id, timestamp: ts };
		}
	}

	return newest.id;
}

// ============================================================================
// Keyboard turn navigation — pure index math over the turn list.
// Kept here (not in the keybinding layer) because the turn-key identity
// contract lives in viewmodel: keying navigation on entryId instead of
// turnKey broke once already (turn-merged turns share identity rules).
// ============================================================================

/** Next focused turn key for j/k-style action navigation.
 * `turns` is the full VM turn list (non-content turns are filtered here);
 * `fallbackIndex` is lazy (a callback) because the caller's fallback computes
 * DOM positions — only paid when the focused turn is stale or missing.
 * Clamps at both ends; returns null only for an empty list. */
export function nextFocusedTurnKey(
	turns: TurnVM[],
	focusedTurnId: string | null,
	direction: "prev" | "next",
	fallbackIndex: () => number,
): string | null {
	const nav = turns.filter((t) => t.kind === "user" || t.kind === "assistant");
	if (nav.length === 0) return null;
	let idx = nav.findIndex((t) => turnKeyOf(t) === focusedTurnId);
	if (idx === -1) idx = fallbackIndex();
	idx = direction === "next" ? idx + 1 : idx - 1;
	idx = Math.max(0, Math.min(nav.length - 1, idx));
	return turnKeyOf(nav[idx]);
}

// ============================================================================
// Live activity phase — what the streaming turn is currently doing.
// Drives the notification/summary surface (web client maps it to an icon).
// Pure projection over the ViewModel, not the Document: it reads only the
// last turn's blocks.
// ============================================================================

export type ActivityPhase = "thinking" | "tool" | "text";

/** Phase of the currently-streaming turn: the latest block that carries a
 * live signal. Walks the last assistant turn's blocks backwards — the latest
 * block is the current phase — skipping finished tools (result attached) and
 * redacted thinking (no live signal). Falls back to "text" when the last
 * turn isn't an assistant turn or every block is done/redacted. */
export function liveActivityPhase(vm: ViewModel): ActivityPhase {
	const lastTurn = vm.turns[vm.turns.length - 1];
	if (!lastTurn || lastTurn.kind !== "assistant") return "text";
	for (let i = lastTurn.blocks.length - 1; i >= 0; i--) {
		const block = lastTurn.blocks[i];
		if (block.blockType === "tool") {
			if (block.status !== "done" && block.status !== "error") return "tool";
		} else if (block.blockType === "thinking") {
			if (!block.redacted) return "thinking";
		} else {
			return "text";
		}
	}
	return "text"; // all blocks done/redacted — no live signal
}

// ============================================================================
// Renderer-side grouping helper — consecutive-action group detection.
//
// Grouping is renderer-owned (ADR 07): the ViewModel has no group entity.
// This pure helper is shared by the renderer (action-group sections) and the
// reconnect re-pull (resolving expanded group keys back to actions), so
// both derive identical group keys.
// ============================================================================

export type TurnSegment = { kind: "text"; block: TextBlockVM } | { kind: "group"; key: string; actions: ActionVM[] };

/**
 * Split an AssistantTurn's flat block list into text blocks and maximal
 * groups of consecutive actions. The group key is the first action's
 * `${entryId}:${blockIndex}` — stable under seal (block indices are
 * append-only; entry-id renames go through migrateExpandKeys).
 */
export function segmentBlocks(blocks: AssistantBlockVM[]): TurnSegment[] {
	const segments: TurnSegment[] = [];
	let i = 0;
	while (i < blocks.length) {
		const block = blocks[i];
		if (block.blockType === "text") {
			segments.push({ kind: "text", block });
			i++;
			continue;
		}
		const actions: ActionVM[] = [];
		while (i < blocks.length && blocks[i].blockType !== "text") {
			actions.push(blocks[i] as ActionVM);
			i++;
		}
		segments.push({
			kind: "group",
			key: `${actions[0].entryId}:${actions[0].blockIndex}`,
			actions,
		});
	}
	return segments;
}

/** Mid-turn inline git stamps assigned to action groups (ADR 10 v2). */
export interface GroupGitChanges {
	/** Inline git stamps per group key (the group the stamp renders inside). */
	byGroup: Map<string, InlineGitStamp[]>;
	/** Inline git stamps with no group to fold into (a text-only turn) — the
	 * renderer falls back to standalone cards after the turn's segments. */
	unattached: InlineGitStamp[];
}

/** Assign a turn's mid-turn inline git stamps to its action groups: a stamp
 * renders inside the group owning its `afterBlockKey` action; when that block is
 * text (a turn_end stamp after a closing text block, say), it attaches to the
 * nearest group *before* that text. Both resolutions are prefix-stable —
 * everything preceding the anchor is immutable — so a stamp keeps its group
 * (and therefore its DOM parent) as the turn grows. Resolving against the
 * turn's last group instead would let a stamp hop groups mid-stream, which
 * remounts its card. */
export function assignGroupGitChanges(segments: TurnSegment[], stamps: InlineGitStamp[]): GroupGitChanges {
	const byGroup = new Map<string, InlineGitStamp[]>();
	const unattached: InlineGitStamp[] = [];
	if (stamps.length === 0) return { byGroup, unattached };
	const groupOfAction = new Map<string, string>();
	// Text block key → the group preceding it (absent when no group is before).
	const groupBeforeText = new Map<string, string>();
	let lastGroupKey: string | null = null;
	for (const seg of segments) {
		if (seg.kind === "group") {
			lastGroupKey = seg.key;
			for (const s of seg.actions) groupOfAction.set(`${s.entryId}:b${s.blockIndex}`, seg.key);
		} else if (lastGroupKey !== null) {
			groupBeforeText.set(`${seg.block.entryId}:b${seg.block.blockIndex}`, lastGroupKey);
		}
	}
	for (const stamp of stamps) {
		const key = groupOfAction.get(stamp.afterBlockKey) ?? groupBeforeText.get(stamp.afterBlockKey) ?? null;
		if (key === null) {
			unattached.push(stamp);
		} else {
			const list = byGroup.get(key);
			if (list) list.push(stamp);
			else byGroup.set(key, [stamp]);
		}
	}
	return { byGroup, unattached };
}

// ============================================================================
// Lazy pulls — single source of truth for action → lazy-field mapping.
// Components call actionPulls during render and enqueue pending pulls
// (ADR 09); the pull loop is the sole fetcher.
// ============================================================================

// ---------------------------------------------------------------------------
// Session accounting re-export (see accounting.ts).
// ---------------------------------------------------------------------------
export type { ModelCostRow, SessionAccounting } from "./accounting.ts";
export { sessionAccounting } from "./accounting.ts";
// ---------------------------------------------------------------------------
// apply-patch re-exports (see apply-patch.ts).
// ---------------------------------------------------------------------------
export type { ApplyPatchChunk, ApplyPatchParse, ApplyPatchSection } from "./apply-patch.ts";
export { applyPatchInput, extractApplyPatchPaths, parseApplyPatch } from "./apply-patch.ts";

// ---------------------------------------------------------------------------
// Tree viewmodel re-exports (Pass 1 + Pass 2 — see tree.ts).
// ---------------------------------------------------------------------------
export type {
	Fork,
	HistoryNode,
	HistoryTree,
	LaneLayout,
	Lineage,
	PlacedNode,
} from "./tree.ts";
export {
	collapseDrafts,
	computeActiveUserPath,
	computeHistoryTree,
	computeLaneLayout,
} from "./tree.ts";

/**
 * Pending pulls for one rendered action (ADR 09: components declare pending
 * pulls during render). A visible think action always needs `thinking` (the
 * inline one-line rendering needs it even collapsed); a visible tool action
 * always needs `arguments` (the summary needs it); an expanded tool action
 * additionally needs its linked result content/details.
 */
export function actionPulls(action: ActionVM, expanded: boolean): PullRequestItem[] {
	if (action.blockType === "thinking") {
		if (action.redacted) return [];
		return [
			{
				entryId: action.entryId,
				fieldPath: `/entries/${action.entryId}/content/${action.blockIndex}/thinking`,
			},
		];
	}
	const pending: PullRequestItem[] = [
		{
			entryId: action.entryId,
			fieldPath: `/entries/${action.entryId}/content/${action.blockIndex}/arguments`,
		},
	];
	if (expanded && action.result) {
		pending.push(...resultPullPaths(action.result.entryId));
	}
	return pending;
}

/** Tool result lazy field paths. */
export function resultPullPaths(resultId: string): PullRequestItem[] {
	return [
		{ entryId: resultId, fieldPath: `/entries/${resultId}/content` },
		{ entryId: resultId, fieldPath: `/entries/${resultId}/details` },
	];
}

// ---------------------------------------------------------------------------
// Action kind — pure mapping from tool name to the visual kind used by the
// renderer to tint the action's tinted row. The tinted row's hue carries the kind;
// status is not surfaced as color (the agent self-corrects, and the
// turn-header timing already signals in-flight work). Read-like tools
// (grep/find/ls/glob) share the bland read hue so they recede; unknown
// tools also default to read so nothing un-elevated pops.
// ---------------------------------------------------------------------------

export type ActionKind = "read" | "bash" | "write" | "edit" | "think";

/** Kind hue — the color group a kind maps to. edit + write share the
 * mutate hue (file mutation); the label/details still distinguish them,
 * only the tinted row hue merges. This is the single source of truth for the
 * row strip/tint and the group legend dots. */
export type ActionHue = "mutate" | "bash" | "think" | "read";

export function kindForTool(name: string): ActionKind {
	switch (name) {
		case "bash":
		case "powershell":
			return "bash";
		case "write":
			return "write";
		case "edit":
		case "apply_patch":
			return "edit";
		case "read":
		case "grep":
		case "find":
		case "ls":
		case "glob":
			return "read";
		default:
			return "read";
	}
}

/** Map a kind to its color group. edit/write → mutate. */
export function kindHue(kind: ActionKind): ActionHue {
	switch (kind) {
		case "edit":
		case "write":
			return "mutate";
		case "bash":
			return "bash";
		case "think":
			return "think";
		case "read":
			return "read";
	}
}

// ---------------------------------------------------------------------------
// Model cycling — pure, browser-safe. Keys on the full (provider, modelId)
// pair so same-id models offered by multiple providers cycle from the
// correct slot instead of the first id match.
// ---------------------------------------------------------------------------

/** A catalog entry (ModelInfo / ScopedModelInfo) — both carry provider + id. */
export interface ModelRefLike {
	provider: string;
	id: string;
}

/**
 * Return the next/previous catalog entry relative to `current`. Matches on the
 * full (provider, modelId) pair so same-id models offered by multiple
 * providers cycle from the correct slot instead of the first id match.
 */
export function findNextModel(
	models: readonly ModelRefLike[],
	current: ModelRef,
	direction: "forward" | "backward",
): ModelRefLike | undefined {
	if (models.length === 0) return undefined;
	const idx = models.findIndex((m) => m.provider === current.provider && m.id === current.modelId);
	const len = models.length;
	return direction === "forward" ? models[(idx + 1) % len] : models[(idx - 1 + len) % len];
}

/**
 * Whether a catalog entry is the active model. Keys on the full
 * (provider, modelId) pair so two same-id models from different providers
 * don't both match (the pre-fix bug highlighted every colliding row).
 */
export function isModelSelected(m: ModelRefLike, ref: ModelRef): boolean {
	return m.provider === ref.provider && m.id === ref.modelId;
}
