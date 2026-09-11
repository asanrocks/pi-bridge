// ============================================================================
// Composer — fixed card at viewport bottom. Two visual modes:
//   collapsed (36px bar: dot + placeholder) and expanded (textarea +
//   control row). Streaming and editing are behavioral overlays on
//   expanded: both auto-expand; streaming swaps Send for Stop and
//   auto-collapses on turn end (if the textarea is empty); editing
//   pre-fills the textarea and Escape cancels.
//
// The textarea content is the store-owned `draft` (ComposerDraft: idle /
// compose / edit), not local React state. That split was the root of the
// old bugs (blur losing edit text, offline send losing input, no
// cross-session persistence): the text lived in Composer while the edit
// pointer lived in the store, so collapse (textarea unmount) orphaned
// them. With the draft in the store it survives collapse, blur, offline
// sends, and page refresh (via draftPersistence). Composer is now a view:
// onChange → setDraftText, blur → blurDraft (salvage/discard), Enter →
// onCommit (App does the atomic RPC; clears draft only on success).
// ============================================================================

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModelInfo, ModelRef, ScopedModelInfo } from "../../../../src/core/index.ts";
import { sessionAccounting } from "../../../../src/viewmodel/index.ts";
import { MAX_ATTACHMENTS, prepareImageFiles } from "../../infra/imageResize.ts";
import { useStore } from "../../infra/store.tsx";
import { useMediaQuery } from "../../infra/useMediaQuery.ts";
import { listFilesRpc } from "../../infra/useRpc.ts";
import { displayModelName } from "../../render/modelNames.ts";
import styles from "./Composer.module.css";
import { CostPopover } from "./CostPopover.tsx";
import { formatCost } from "./formatters.ts";
import { ModelPickerPortal } from "./ModelPickerPortal.tsx";
import { PathCompletion } from "./PathCompletion.tsx";

interface ComposerProps {
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
	onSetModel: (provider: string, model: string) => void;
	onSetThinkingLevel: (level: string) => void;
	onCycleModel: (direction: "forward" | "backward") => void;
}

export const Composer = memo(function Composer({
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
}: ComposerProps) {
	// ── Composer expanded/collapsed state ───────────────────────────────
	// Owned in the store so the app keybinding layer can drive `/` (expand)
	// without reaching into Composer internals. Visual only — decoupled
	// from the draft: the bar can collapse while a compose draft stays
	// dormant, re-expanding to the saved text.
	const expanded = useStore((s) => s.composerExpanded);
	const setExpanded = useStore((s) => s.setComposerExpanded);
	// Soft keyboards (coarse pointer) use Enter to insert a newline; sending
	// is via the button. Physical keyboards (fine pointer) keep Enter-to-send.
	const finePointer = useMediaQuery("(pointer: fine)");

	// ── Draft — the single source of truth for the textarea ──────────────
	const draft = useStore((s) => s.draft);
	const setDraftText = useStore((s) => s.setDraftText);
	const addDraftImages = useStore((s) => s.addDraftImages);
	const removeDraftImage = useStore((s) => s.removeDraftImage);
	const blurDraft = useStore((s) => s.blurDraft);
	const clearDraft = useStore((s) => s.clearDraft);
	const pushToast = useStore((s) => s.pushToast);
	const isEditing = draft.kind === "edit";
	const draftText = draft.kind === "idle" ? "" : draft.text;
	const draftImages = draft.kind === "compose" ? (draft.images ?? []) : [];

	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const composerWrapperRef = useRef<HTMLDivElement>(null);
	// Saved cursor position for draft-preserving collapse (Escape on a
	// compose draft). Restored when the textarea remounts on re-expand.
	const cursorPosRef = useRef<[number, number]>([0, 0]);

	// Session accounting — pure client-side billing ledger (viewmodel
	// sessionAccounting) over the full entry map. Unlike the server's
	// thread-scoped /status/stats, this is the whole-session total: every
	// branch, including pre-compaction messages — monotonic and
	// navigation-invariant, matching pi-tui's footer. Recomputed per patch
	// (a few-hundred-entry sum, negligible); entries ref changes on every
	// document patch, so the memo follows streaming updates.
	const entries = useStore((s) => s.document.entries);
	const accounting = useMemo(() => sessionAccounting(entries, models), [entries, models]);
	const contextUsage = useStore((s) => s.document.status.contextUsage);
	// Pending steers queued mid-stream (AgentSession queue_update →
	// /status/pendingSteer). Rendered as read-only draft chips above the
	// textarea; × clears the whole queue (session.clearQueue, the only
	// primitive the AgentSession exposes for this).
	const pendingSteer = useStore((s) => s.document.status.pendingSteer);
	// Compaction is the non-streaming busy state (isBusy = isStreaming ||
	// isCompacting). Send stays available during streaming (it queues a
	// steer) but is disabled during compaction.
	const isCompacting = isBusy && !isStreaming;

	// Completion state
	const [completionOpen, setCompletionOpen] = useState(false);
	const [completions, setCompletions] = useState<Array<{ path: string; isDirectory: boolean }>>([]);
	const [completionIndex, setCompletionIndex] = useState(0);
	const [tokenStart, setTokenStart] = useState(0);

	// Model picker portal state
	const [portalOpen, setPortalOpen] = useState(false);
	const [portalAnchor, setPortalAnchor] = useState<DOMRect | null>(null);
	const pickerBtnRef = useRef<HTMLButtonElement>(null);

	// Cost-breakdown popover state
	const [costOpen, setCostOpen] = useState(false);
	const [costAnchor, setCostAnchor] = useState<DOMRect | null>(null);
	const costBtnRef = useRef<HTMLButtonElement>(null);

	// ── Auto-expand transitions ─────────────────────────────────────────
	// Open when streaming or editing starts, or while steers are queued.
	// Never auto-close — collapsing is driven by explicit user actions
	// (Escape, blur, send) so Backspace clearing the input doesn't
	// unexpectedly collapse the composer. The bar staying open while a
	// dormant compose draft exists is intentional (the draft has nowhere
	// to "go"; collapse is visual, the draft persists either way).
	useEffect(() => {
		if (isStreaming || isEditing || pendingSteer.length > 0) {
			setExpanded(true);
		}
	}, [isStreaming, isEditing, pendingSteer.length, setExpanded]);

	// Publish the live composer footprint so the conversation's bottom
	// padding (and thus the last message) clears the fixed card as it
	// expands/collapses. offsetHeight includes the card + the wrapper's
	// bottom padding (gap + safe area), i.e. the full occluded height.
	useEffect(() => {
		const el = composerWrapperRef.current;
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
	// scroll tick as the URL bar animated (flicker), because innerHeight
	// stayed full while height excluded the URL bar but offsetTop reported 0.
	// The formula stays as a fallback for browsers that ignore
	// interactive-widget (they default to resizes-visual). rAF-coalesced so
	// resize/scroll bursts during URL-bar transitions paint one value per
	// frame instead of transient mismatches. Degrades to bottom:0 with no
	// visualViewport.
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

	// ── Image attachments ───────────────────────────────────────────────

	const fileInputRef = useRef<HTMLInputElement>(null);
	const [isDragOver, setDragOver] = useState(false);
	// dragenter/dragleave fire per child element; a counter is the standard
	// fix for the flicker (leave fires when moving onto a child).
	const dragDepthRef = useRef(0);

	const addFiles = useCallback(
		(files: Iterable<File>) => {
			const list = [...files].filter((f) => f instanceof File) as File[];
			if (list.length === 0) return;
			void (async () => {
				const room = MAX_ATTACHMENTS - draftImages.length;
				if (room <= 0) {
					pushToast(`attach:${Date.now()}`, `At most ${MAX_ATTACHMENTS} images per message`);
					return;
				}
				const accepted = list.slice(0, room);
				const overflow = list.length - accepted.length;
				const { images, errors } = await prepareImageFiles(accepted);
				for (const err of errors) pushToast(`attach:${Date.now()}:${err}`, err);
				if (overflow > 0) {
					pushToast(`attach:cap:${Date.now()}`, `At most ${MAX_ATTACHMENTS} images per message`);
				}
				addDraftImages(images);
			})();
		},
		[draftImages.length, addDraftImages, pushToast],
	);

	const handlePaste = useCallback(
		(e: React.ClipboardEvent) => {
			const files = e.clipboardData?.files;
			if (files && files.length > 0) {
				e.preventDefault();
				addFiles(files);
			}
		},
		[addFiles],
	);

	const handleDragEnter = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		dragDepthRef.current += 1;
		setDragOver(true);
	}, []);

	// dragover fires continuously while hovering; it must NOT touch the
	// enter/leave counter (inflating it strands the drop highlight on).
	const handleDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault();
	}, []);

	const handleDragLeave = useCallback(() => {
		dragDepthRef.current -= 1;
		if (dragDepthRef.current <= 0) {
			dragDepthRef.current = 0;
			setDragOver(false);
		}
	}, []);

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			dragDepthRef.current = 0;
			setDragOver(false);
			if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
				addFiles(e.dataTransfer.files);
			}
		},
		[addFiles],
	);

	// ── Bar click handler ───────────────────────────────────────────────

	const handleBarClick = useCallback(() => {
		if (!connected) return;
		if (!expanded) {
			setExpanded(true);
		} else {
			textareaRef.current?.focus();
		}
	}, [connected, expanded, setExpanded]);

	// ── Textarea ────────────────────────────────────────────────────────

	// The textarea is a controlled view onto `draft`. Size is handled by CSS
	// field-sizing:content — no JS autoResize needed.
	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			setDraftText(e.target.value);
		},
		[setDraftText],
	);

	// Close completion on send or stop
	const closeCompletion = useCallback(() => {
		setCompletionOpen(false);
		setCompletions([]);
		setCompletionIndex(0);
	}, []);

	// Composer only triggers the commit; App owns the RPC + draft-clear.
	// App clears the draft optimistically (before the RPC awaits the
	// turn) and restores it on failure, so the textarea empties
	// immediately on send and a second Enter is a no-op (empty draft) —
	// no in-flight dedup needed, which would have blocked steering during
	// the turn.
	const hasContent = draftText.trim().length > 0 || draftImages.length > 0;
	const handleSend = useCallback(() => {
		if (!hasContent) return;
		closeCompletion();
		void onCommit();
	}, [hasContent, onCommit, closeCompletion]);

	// Stop: halt the current generation AND salvage any queued steers into
	// the draft so they aren't lost. The server-side abort clears the
	// session queue (preventing the post-abort auto-continue from
	// delivering them); the client-side backfill preserves their text as
	// editable input. Queued drafts prepend any in-progress textarea
	// content so nothing is overwritten.
	const handleStop = useCallback(() => {
		if (pendingSteer.length > 0) {
			const drafts = pendingSteer.join("\n\n");
			const current = draft.kind === "compose" ? draft.text : "";
			setDraftText(current.trim() ? `${drafts}\n\n${current}` : drafts);
		}
		onStop();
	}, [pendingSteer, draft, setDraftText, onStop]);

	// ── Blur handler: salvage/discard via the store ──────────────────────
	// Focus moving to something inside the composer keeps the bar up; any
	// other blur target delegates to blurDraft, which applies the
	// salvage/discard rule (modified edit → compose draft; unmodified or
	// empty → idle) and collapses unless streaming/steers keep it up.
	const handleBlur = useCallback(
		(e: React.FocusEvent) => {
			if (composerWrapperRef.current?.contains(e.relatedTarget as Node)) return;
			blurDraft();
		},
		[blurDraft],
	);

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

	// Extract the path-like token before the cursor
	const getPathPrefix = useCallback((): { prefix: string; start: number } | null => {
		const el = textareaRef.current;
		if (!el) return null;
		const cursor = el.selectionStart;
		const before = draftText.slice(0, cursor);

		let start = -1;
		for (let i = before.length - 1; i >= 0; i--) {
			const ch = before[i];
			if (ch === " " || ch === "\t" || ch === '"' || ch === "'" || ch === "=") {
				start = i + 1;
				break;
			}
		}
		if (start === -1) start = 0;

		const token = before.slice(start);
		if (
			token === "" ||
			token.startsWith("/") ||
			token.startsWith("./") ||
			token.startsWith("../") ||
			token.startsWith("~/") ||
			token.includes("/")
		) {
			return { prefix: token, start };
		}
		return null;
	}, [draftText]);

	// Fetch completions from server
	const fetchCompletions = useCallback(async (prefix: string, start: number) => {
		const entries = await listFilesRpc(prefix);
		if (entries.length === 0) {
			setCompletionOpen(false);
			setCompletions([]);
			return;
		}
		setCompletions(entries);
		setCompletionIndex(0);
		setTokenStart(start);
		setCompletionOpen(true);
	}, []);

	// Accept a completion — replace the token from start to cursor
	const acceptCompletion = useCallback(
		(completionIndex: number) => {
			const el = textareaRef.current;
			if (!el || completionIndex < 0 || completionIndex >= completions.length) return;
			const item = completions[completionIndex];
			const cursor = el.selectionStart;
			const before = draftText.slice(0, tokenStart);
			const after = draftText.slice(cursor);
			const displayedPath = item.isDirectory ? `${item.path}/` : item.path;
			const suffix = item.isDirectory ? "" : " ";
			const newInput = before + displayedPath + suffix + after;
			setDraftText(newInput);

			const newCursor = before.length + displayedPath.length + suffix.length;
			requestAnimationFrame(() => {
				if (textareaRef.current) {
					textareaRef.current.selectionStart = newCursor;
					textareaRef.current.selectionEnd = newCursor;
				}
			});

			if (item.isDirectory) {
				fetchCompletions(displayedPath, before.length);
			} else {
				closeCompletion();
			}
		},
		[draftText, completions, tokenStart, setDraftText, fetchCompletions, closeCompletion],
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (completionOpen) {
				if (e.key === "ArrowDown") {
					e.preventDefault();
					setCompletionIndex((i) => Math.min(i + 1, completions.length - 1));
					return;
				}
				if (e.key === "ArrowUp") {
					e.preventDefault();
					setCompletionIndex((i) => Math.max(i - 1, 0));
					return;
				}
				if (e.key === "Enter") {
					e.preventDefault();
					acceptCompletion(completionIndex);
					return;
				}
				if (e.key === "Escape") {
					e.preventDefault();
					closeCompletion();
					return;
				}
				if (e.key === "Tab") {
					e.preventDefault();
					if (completions.length === 1) {
						acceptCompletion(0);
					} else if (e.shiftKey) {
						setCompletionIndex((i) => (i - 1 + completions.length) % completions.length);
					} else {
						setCompletionIndex((i) => (i + 1) % completions.length);
					}
					return;
				}

				if (!e.ctrlKey && !e.metaKey && !e.altKey) {
					closeCompletion();
				}
			}

			if (e.ctrlKey && e.key === "p") {
				e.preventDefault();
				onCycleModel(e.shiftKey ? "backward" : "forward");
				return;
			}

			if (e.key === "Enter" && !e.shiftKey) {
				// Soft keyboards fall through to the default newline insertion;
				// physical keyboards send. (When the completion dropdown is open,
				// the branch above accepts the completion regardless of pointer.)
				if (finePointer) {
					e.preventDefault();
					handleSend();
				}
			} else if (e.key === "Escape") {
				e.preventDefault();
				handleEscape();
			} else if (e.key === "Tab" && !e.shiftKey) {
				// Tab completion is available in both compose and edit drafts —
				// editing a message often involves editing paths too.
				const pathInfo = getPathPrefix();
				if (pathInfo) {
					e.preventDefault();
					fetchCompletions(pathInfo.prefix, pathInfo.start);
				}
			}
		},
		[
			completionOpen,
			completions,
			completionIndex,
			acceptCompletion,
			closeCompletion,
			onCycleModel,
			handleSend,
			handleEscape,
			finePointer,
			getPathPrefix,
			fetchCompletions,
		],
	);

	// Cancel edit (the composer Cancel button). Mirrors Escape's edit-cancel
	// path: clearDraft + collapse. Explicit, like the popover's dismiss — edit
	// is a sticky mode that survives blur, so it needs an explicit exit.
	const handleEditCancel = useCallback(() => {
		clearDraft();
		setExpanded(false);
	}, [clearDraft, setExpanded]);

	// ── Status row data ─────────────────────────────────────────────────

	// Resolve current model display name
	const modelName = model.modelId ? displayModelName(model.provider, model.modelId, models) : "none";
	const selectedModel = models.find((m) => m.provider === model.provider && m.id === model.modelId);
	// The daemon reports capabilities from the model manifest. Keep the
	// global list only for older daemons that do not send capabilities yet.
	const availableThinkingLevels = selectedModel?.supportedThinkingLevels ?? thinkingLevels;

	// Context usage is synced from the server via status.contextUsage.
	// pi's AgentSession.getContextUsage() handles compaction gaps and
	// trailing-message estimation. Null means unknown (post-compaction,
	// no response yet).
	const contextPercent = contextUsage?.percent ?? null;

	// ── Status dot logic ─────────────────────────────────────────────────

	const dotClass = !connected
		? styles.composerDotRed
		: isStreaming
			? styles.composerDotOrange
			: styles.composerDotGreen;

	// ── Render ──────────────────────────────────────────────────────────

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: layout container is the composer drop target; drag affordances have no ARIA role
		<div
			className={styles.composer}
			ref={composerWrapperRef}
			onDragEnter={handleDragEnter}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
			data-dragover={isDragOver || undefined}
		>
			{/* Hidden file input for the attach button */}
			<input
				ref={fileInputRef}
				type="file"
				accept="image/png,image/jpeg,image/webp,image/gif"
				multiple
				className={styles.attachInput}
				tabIndex={-1}
				aria-hidden="true"
				onChange={(e) => {
					if (e.target.files) addFiles(e.target.files);
					e.target.value = ""; // allow re-selecting the same file
				}}
			/>
			{/* Completion dropdown — opens upward from card top */}
			{completionOpen && completions.length > 0 && (
				<PathCompletion
					completions={completions}
					selectedIndex={completionIndex}
					onSelect={acceptCompletion}
					onDismiss={closeCompletion}
				/>
			)}

			{/* Card — rounded, shadowed wrapper; bar when collapsed, body when expanded */}
			<div className={styles.composerCard}>
				{!expanded ? (
					<button type="button" className={styles.composerBar} onClick={handleBarClick} disabled={!connected}>
						<span className={`${styles.composerDot} ${dotClass}`} />
						Type a message...
					</button>
				) : (
					<div className={styles.composerBody}>
						{isEditing && (
							<div className={styles.editHeader}>
								<span className={styles.editHeaderLabel}>Editing message</span>
								<button
									type="button"
									className={styles.editCancelBtn}
									onClick={handleEditCancel}
									aria-label="Cancel edit"
									title="Cancel edit"
								>
									Cancel
								</button>
							</div>
						)}
						{pendingSteer.length > 0 && (
							<div className={styles.steerChips}>
								{pendingSteer.map((text, i) => (
									<span key={`${i}:${text}`} className={styles.steerChip}>
										{text}
									</span>
								))}
								<button
									type="button"
									className={styles.steerClearBtn}
									onClick={onDiscardSteer}
									title="Clear all pending steers"
									aria-label="Clear all pending steers"
								>
									×
								</button>
							</div>
						)}
						{draftImages.length > 0 && (
							<div className={styles.attachChips}>
								{draftImages.map((img, i) => (
									<span key={`${i}:${img.mimeType}:${img.data.length}`} className={styles.attachChip}>
										<img
											className={styles.attachThumb}
											src={`data:${img.mimeType};base64,${img.data}`}
											alt=""
										/>
										<button
											type="button"
											className={styles.attachRemove}
											onClick={() => removeDraftImage(i)}
											aria-label="Remove image"
											title="Remove image"
										>
											×
										</button>
									</span>
								))}
							</div>
						)}
						<textarea
							ref={textareaRef}
							className={styles.composerTextarea}
							value={draftText}
							onChange={handleChange}
							onKeyDown={handleKeyDown}
							onBlur={handleBlur}
							onPaste={handlePaste}
							placeholder={isEditing ? "Edit your message..." : "Type a message..."}
							readOnly={!connected}
						/>

						{/* Control row. Left group ordered context-first (pct, bar, cost):
						   context is the actionable metric, cost is a ledger. Mobile and
						   desktop share this layout; the breakpoint only hides the bar and
						   swaps the model name for a fixed "Models" label (CSS-driven). */}
						<div className={styles.composerControlRow}>
							{/* Left: context % + context bar + cost */}
							<div className={styles.composerControlLeft}>
								<button
									type="button"
									className={styles.attachBtn}
									onClick={() => fileInputRef.current?.click()}
									disabled={!connected || isEditing || draftImages.length >= MAX_ATTACHMENTS}
									aria-label="Attach image"
									title={
										isEditing ? "Images can't be added while editing" : "Attach image (or paste / drag-drop)"
									}
								>
									📎
								</button>
								<span className={styles.composerContextPct}>
									{contextPercent !== null ? `${Math.round(contextPercent)}%` : "?"}
								</span>
								<div className={styles.composerContextBar}>
									{contextPercent !== null && (
										<div className={styles.composerContextBarFill} style={{ width: `${contextPercent}%` }} />
									)}
								</div>
								<button
									ref={costBtnRef}
									type="button"
									className={styles.composerCostBtn}
									onClick={() => {
										setCostAnchor(costBtnRef.current?.getBoundingClientRect() ?? null);
										setCostOpen((v) => !v);
									}}
									aria-label="Token usage breakdown"
								>
									{formatCost(accounting.cost)}
									<span className={styles.composerCostChevron} aria-hidden="true">
										▾
									</span>
								</button>
							</div>

							{/* Right: model picker + Send/Stop */}
							<div className={styles.composerControlRight}>
								<button
									ref={pickerBtnRef}
									type="button"
									className={styles.composerModelBtn}
									onClick={() => {
										setPortalAnchor(pickerBtnRef.current?.getBoundingClientRect() ?? null);
										setPortalOpen((v) => !v);
									}}
									disabled={!connected}
									title="Switch model (Ctrl+P cycles)"
								>
									{/* Label swap is CSS-driven: full name on desktop, fixed "Models"
									    label on narrow screens. Truncating a model name mid-word
									    carries no information; the fixed label is self-describing
									    at a constant width. */}
									<span className={styles.composerModelName}>
										{modelName}
										{thinkingLevel ? (
											<span className={styles.composerModelMuted}> {thinkingLevel}</span>
										) : null}
									</span>
									<span className={styles.composerModelMobileLabel}>Models</span>
									<span className={styles.composerModelChevron} aria-hidden="true">
										▾
									</span>
								</button>

								{/* Send is always available: during streaming it queues a steer
								    (Manager.prompt → streamingBehavior: "steer"); when idle it
								    starts a normal turn. Disabled only when disconnected,
								    empty, or compacting. Stop appears alongside Send during
								    streaming/compaction. Commit is atomic (App clears the draft
								    on RPC success), so the text stays until the send resolves. */}
								<button
									type="button"
									className={styles.composerSendBtn}
									onClick={handleSend}
									disabled={!connected || !hasContent || isCompacting}
									aria-label={isStreaming ? "Queue steer" : "Send"}
									title={isStreaming ? "Queue steer" : "Send"}
								>
									➤
								</button>
								{isBusy && (
									<button
										type="button"
										className={styles.composerStopBtn}
										onClick={handleStop}
										aria-label="Stop"
										title="Stop"
									>
										■
									</button>
								)}
							</div>
						</div>
					</div>
				)}
			</div>

			{/* Cost breakdown popover */}
			{costOpen && (
				<CostPopover
					accounting={accounting}
					models={models}
					anchorRect={costAnchor}
					onClose={() => setCostOpen(false)}
				/>
			)}

			{/* Model picker portal */}
			{portalOpen && (
				<ModelPickerPortal
					anchorRect={portalAnchor}
					models={models}
					scopedModels={scopedModels}
					thinkingLevels={availableThinkingLevels}
					currentModelRef={model}
					currentThinkingLevel={thinkingLevel}
					onSelectModel={(provider, modelId) => {
						onSetModel(provider, modelId);
						setPortalOpen(false);
					}}
					onSelectThinkingLevel={(level) => {
						onSetThinkingLevel(level);
					}}
					onClose={() => setPortalOpen(false)}
				/>
			)}
		</div>
	);
});
