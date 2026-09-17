// ============================================================================
// ComposeDock — the session-attached compose surface: a fixed dock at the
// viewport bottom that swaps between the collapsed ComposeBar and the
// expanded ComposeCard. Owns everything session-specific around the card:
// the expand/collapse lifecycle (with dormant drafts and cursor restore),
// turn wiring (steers, edit, stop, streaming auto-expand), the ledger
// (context + cost), and the dock layout effects (`--composer-h` footprint,
// soft-keyboard pinning). The Project home renders the same ComposeCard via
// HomeCompose with none of this — see ComposeCard.tsx for the split.
//
// The textarea content is the store-owned `draft` (ComposerDraft: idle /
// compose / edit), not local React state — that split is what makes durable
// drafts work (blur salvage, offline sends, per-scope persistence). The dock
// is a view: onChange → setDraftText, blur → blurDraft, Enter → onCommit
// (useComposerCommit does the atomic RPC; clears the draft only on success).
// ============================================================================

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModelInfo, ModelRef, ScopedModelInfo } from "../../../../src/core/index.ts";
import { sessionAccounting } from "../../../../src/viewmodel/index.ts";
import { useStore } from "../../infra/store.tsx";
import { ComposeBar, type ComposeDot } from "./ComposeBar.tsx";
import cardStyles from "./ComposeCard.module.css";
import { ComposeCard } from "./ComposeCard.tsx";
import styles from "./ComposeDock.module.css";
import { CostPopover } from "./CostPopover.tsx";
import { formatCost } from "./formatters.ts";
import { useComposeCapabilities } from "./useComposeCapabilities.ts";

interface ComposeDockProps {
	onCommit: () => void | Promise<void>;
	onStop: () => void;
	onDiscardSteer: () => void;
	isBusy: boolean;
	connected: boolean;
	model: ModelRef;
	thinkingLevel: string;
	models: ModelInfo[];
	scopedModels: ScopedModelInfo[];
	thinkingLevels: string[];
	isStreaming: boolean;
	onSetModel: (provider: string, modelId: string) => void;
	onSetThinkingLevel: (level: string) => void;
	onCycleModel: (direction: "forward" | "backward") => void;
}

export const ComposeDock = memo(function ComposeDock({
	onCommit,
	onStop,
	onDiscardSteer,
	isBusy,
	connected,
	model,
	thinkingLevel,
	models,
	scopedModels,
	thinkingLevels,
	isStreaming,
	onSetModel,
	onSetThinkingLevel,
	onCycleModel,
}: ComposeDockProps) {
	// ── Composer expanded/collapsed state ───────────────────────────────
	// Owned in the store so the app keybinding layer can drive `/` (expand)
	// without reaching into dock internals. Visual only — decoupled from
	// the draft: the bar can collapse while a compose draft stays dormant,
	// re-expanding to the saved text.
	const expanded = useStore((s) => s.composerExpanded);
	const setExpanded = useStore((s) => s.setComposerExpanded);

	// ── Draft — the single source of truth for the textarea ──────────────
	const draft = useStore((s) => s.draft);
	const setDraftText = useStore((s) => s.setDraftText);
	const blurDraft = useStore((s) => s.blurDraft);
	const clearDraft = useStore((s) => s.clearDraft);
	const isEditing = draft.kind === "edit";
	const draftText = draft.kind === "idle" ? "" : draft.text;

	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const dockRef = useRef<HTMLDivElement>(null);
	// Saved cursor position for draft-preserving collapse (Escape on a
	// compose draft). Restored when the textarea remounts on re-expand.
	const cursorPosRef = useRef<[number, number]>([0, 0]);

	// Session accounting — pure client-side billing ledger (viewmodel
	// sessionAccounting) over the full entry map. Unlike the server's
	// thread-scoped /status/stats, this is the whole-session total: every
	// branch, including pre-compaction messages — monotonic and
	// navigation-invariant, matching pi-tui's footer.
	const entries = useStore((s) => s.document.entries);
	const accounting = useMemo(() => sessionAccounting(entries, models), [entries, models]);
	const contextUsage = useStore((s) => s.document.status.contextUsage);
	// Pending steers queued mid-stream (AgentSession queue_update →
	// /status/pendingSteer). Rendered as read-only draft chips above the
	// textarea; × clears the whole queue.
	const pendingSteer = useStore((s) => s.document.status.pendingSteer);
	// Compaction is the non-streaming busy state. Send stays available during
	// streaming (it queues a steer) but is disabled during compaction.
	const isCompacting = isBusy && !isStreaming;

	// Cost-breakdown popover state
	const [costOpen, setCostOpen] = useState(false);
	const [costAnchor, setCostAnchor] = useState<DOMRect | null>(null);
	const costBtnRef = useRef<HTMLButtonElement>(null);

	// ── Shared compose capabilities (attachments + path completion) ──────
	// Completion is Project-scoped (ADR 12) and the hook reads the current
	// address from the store, so this is identical to the Project home's call.
	const capabilities = useComposeCapabilities({ textareaRef });

	// ── Auto-expand transitions ─────────────────────────────────────────
	// Open when streaming or editing starts, or while steers are queued.
	// Never auto-close — collapsing is driven by explicit user actions
	// (Escape, blur, send) so Backspace clearing the input doesn't
	// unexpectedly collapse the composer. The bar staying open while a
	// dormant compose draft exists is intentional (the draft has nowhere to
	// "go"; collapse is visual, the draft persists either way).
	useEffect(() => {
		if (isStreaming || isEditing || pendingSteer.length > 0) {
			setExpanded(true);
		}
	}, [isStreaming, isEditing, pendingSteer.length, setExpanded]);

	// Publish the live dock footprint so the conversation's bottom padding
	// (and thus the last message) clears the fixed card as it expands and
	// collapses. offsetHeight includes the card + the wrapper's bottom
	// padding (gap + safe area), i.e. the full occluded height.
	useEffect(() => {
		const el = dockRef.current;
		if (!el) return;
		const update = () => {
			document.documentElement.style.setProperty("--composer-h", `${el.offsetHeight}px`);
		};
		update();
		const ro = new ResizeObserver(update);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// Pin the fixed composer above the mobile soft keyboard. The viewport
	// meta's `interactive-widget=resizes-content` makes modern browsers
	// (Firefox 126+, Chrome 108+, Safari 16.4+) resize the *layout* viewport
	// on keyboard open, so `bottom: 0` lands on the keyboard top directly
	// and this overlap formula yields ~0. That sidesteps Firefox Android's
	// quirk where visualViewport.offsetTop does NOT track the URL bar: under
	// the default resizes-visual the formula inflated the overlap by the
	// URL-bar height (a steady gap above the keyboard) and thrashed on every
	// scroll tick as the URL bar animated (flicker). The formula stays as a
	// fallback for browsers that ignore interactive-widget (they default to
	// resizes-visual). rAF-coalesced so resize/scroll bursts during URL-bar
	// transitions paint one value per frame instead of transient mismatches.
	// Degrades to bottom:0 with no visualViewport.
	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;
		const apply = () => {
			const overlap = window.innerHeight - vv.height - vv.offsetTop;
			document.documentElement.style.setProperty("--vv-keyboard", `${Math.max(0, overlap)}px`);
		};
		let rafId = 0;
		const schedule = () => {
			if (rafId) return;
			rafId = requestAnimationFrame(() => {
				rafId = 0;
				apply();
			});
		};
		apply(); // synchronous initial set; subsequent updates are rAF-coalesced
		vv.addEventListener("resize", schedule);
		vv.addEventListener("scroll", schedule);
		return () => {
			if (rafId) cancelAnimationFrame(rafId);
			vv.removeEventListener("resize", schedule);
			vv.removeEventListener("scroll", schedule);
		};
	}, []);

	// ── Focus textarea on expand ────────────────────────────────────────

	useEffect(() => {
		if (expanded) {
			requestAnimationFrame(() => {
				const el = textareaRef.current;
				if (el) {
					el.focus();
					el.selectionStart = cursorPosRef.current[0];
					el.selectionEnd = cursorPosRef.current[1];
				}
			});
		}
	}, [expanded]);

	// beginEdit while the bar is already expanded doesn't change
	// `composerExpanded`, so the effect above doesn't re-run and the
	// textarea is left unfocused — a later click-away then can't blur it,
	// so blurDraft never runs and edit mode sticks. Focus the textarea when
	// an edit begins (and only then: not on typing, which would reset the
	// cursor, nor on salvage, which exits edit).
	const editEntryId = draft.kind === "edit" ? draft.entryId : null;
	useEffect(() => {
		if (editEntryId === null) return;
		requestAnimationFrame(() => {
			const el = textareaRef.current;
			if (el) el.focus();
		});
	}, [editEntryId]);

	// ── Bar click handler ───────────────────────────────────────────────

	const handleBarClick = useCallback(() => {
		if (!connected) return;
		if (!expanded) {
			setExpanded(true);
		} else {
			textareaRef.current?.focus();
		}
	}, [connected, expanded, setExpanded]);

	// ── Commit ──────────────────────────────────────────────────────────
	// The dock only triggers the commit; useComposerCommit (App) owns the
	// RPC + draft-clear. It clears the draft optimistically (before the RPC
	// awaits the turn) and restores it on failure, so the textarea empties
	// immediately on send and a second Enter is a no-op (empty draft) — no
	// in-flight dedup needed, which would have blocked steering during the
	// turn.
	const closeCompletion = capabilities.closeCompletion;
	const handleCommit = useCallback(() => {
		closeCompletion();
		void onCommit();
	}, [closeCompletion, onCommit]);

	// Stop: halt the current generation AND salvage any queued steers into
	// the draft so they aren't lost. The server-side abort clears the
	// session queue (preventing the post-abort auto-continue from delivering
	// them); the client-side backfill preserves their text as editable
	// input. Queued drafts prepend any in-progress textarea content so
	// nothing is overwritten.
	const handleStop = useCallback(() => {
		if (pendingSteer.length > 0) {
			const drafts = pendingSteer.join("\n\n");
			const current = draft.kind === "compose" ? draft.text : "";
			setDraftText(current.trim() ? `${drafts}\n\n${current}` : drafts);
		}
		onStop();
	}, [pendingSteer, draft, setDraftText, onStop]);

	// ── Escape: collapse; cancel edit if editing ───────────────────────
	// Edit drafts are cleared (Escape exits edit mode). Compose drafts are
	// kept dormant (collapse is visual; the draft re-shows on re-expand),
	// with the cursor position saved for restoration. Steers queued
	// mid-stream block collapse so the draft chips stay visible.
	const handleEscape = useCallback(() => {
		if (isEditing) {
			clearDraft();
			setExpanded(false);
			return;
		}
		if (pendingSteer.length > 0) return;
		if (textareaRef.current) {
			cursorPosRef.current = [textareaRef.current.selectionStart ?? 0, textareaRef.current.selectionEnd ?? 0];
		}
		setExpanded(false);
	}, [isEditing, clearDraft, pendingSteer.length, setExpanded]);

	// Cancel edit (the edit header's Cancel button). Mirrors Escape's
	// edit-cancel path: clearDraft + collapse. Explicit, like the popover's
	// dismiss — edit is a sticky mode that survives blur, so it needs an
	// explicit exit.
	const handleEditCancel = useCallback(() => {
		clearDraft();
		setExpanded(false);
	}, [clearDraft, setExpanded]);

	// ── Status dot ──────────────────────────────────────────────────────

	const dot: ComposeDot = !connected ? "red" : isStreaming ? "orange" : "green";

	// Context usage is synced from the server via status.contextUsage.
	// pi's AgentSession.getContextUsage() handles compaction gaps and
	// trailing-message estimation. Null means unknown (post-compaction,
	// no response yet).
	const contextPercent = contextUsage?.percent ?? null;

	// The session ledger: context % + bar + cost (the card's leftControls
	// slot; the Project home renders none of this).
	const leftControls = (
		<>
			<span className={cardStyles.composerContextPct}>
				{contextPercent !== null ? `${Math.round(contextPercent)}%` : "?"}
			</span>
			<div className={cardStyles.composerContextBar}>
				{contextPercent !== null && (
					<div className={cardStyles.composerContextBarFill} style={{ width: `${contextPercent}%` }} />
				)}
			</div>
			<button
				ref={costBtnRef}
				type="button"
				className={cardStyles.composerCostBtn}
				onClick={() => {
					setCostAnchor(costBtnRef.current?.getBoundingClientRect() ?? null);
					setCostOpen((v) => !v);
				}}
				aria-label="Token usage breakdown"
			>
				{formatCost(accounting.cost)}
				<span className={cardStyles.composerCostChevron} aria-hidden="true">
					▾
				</span>
			</button>
		</>
	);

	// ── Render ──────────────────────────────────────────────────────────

	return (
		<div className={styles.composer} ref={dockRef}>
			{!expanded ? (
				<ComposeBar dot={dot} placeholder="Type a message..." onClick={handleBarClick} disabled={!connected} />
			) : (
				<ComposeCard
					{...capabilities.cardProps}
					value={draftText}
					onChange={setDraftText}
					onCommit={handleCommit}
					connected={connected}
					placeholder={isEditing ? "Edit your message..." : "Type a message..."}
					onBlurOutside={blurDraft}
					onEscape={handleEscape}
					textareaRef={textareaRef}
					attachDisabled={isEditing}
					attachTitle={isEditing ? "Images can't be added while editing" : undefined}
					editLabel={isEditing ? "Editing message" : null}
					onCancelEdit={handleEditCancel}
					pendingSteer={pendingSteer}
					onDiscardSteer={onDiscardSteer}
					isBusy={isBusy}
					isCompacting={isCompacting}
					onStop={handleStop}
					model={model}
					models={models}
					scopedModels={scopedModels}
					thinkingLevel={thinkingLevel}
					thinkingLevels={thinkingLevels}
					onSetModel={onSetModel}
					onSetThinkingLevel={onSetThinkingLevel}
					onCycleModel={onCycleModel}
					leftControls={leftControls}
				/>
			)}

			{/* Cost breakdown popover */}
			{costOpen && (
				<CostPopover
					accounting={accounting}
					models={models}
					anchorRect={costAnchor}
					onClose={() => setCostOpen(false)}
				/>
			)}
		</div>
	);
});
