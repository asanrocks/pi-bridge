// ============================================================================
// ComposeCard — the expanded compose surface: textarea + attachment chips +
// control row, inside the shared card shell. Presentational and props-only:
// no store reads, no knowledge of sessions, documents, or the wire. The two
// surfaces (the session dock and the Project home) are containers that own
// the draft, commit path, turn wiring, and layout; everything they differ on
// enters as a slot or an optional prop:
//   - leftControls?: session ledger (cost/context); home renders nothing
//   - onStop?/isBusy: turn-aware Stop (session only)
//   - pendingSteer/onDiscardSteer, editLabel/onCancelEdit: session overlays
//   - model: ModelRef | null — null renders "none" (no model available)
// The card shell spec (elevation, radius, surface) is shared with ComposeBar
// via the same CSS module — one spec per role (ADR 07 §Styling invariants).
// ============================================================================

import { memo, type ReactNode, useCallback, useRef, useState } from "react";
import type { ImageContent, ModelInfo, ModelRef, ScopedModelInfo } from "../../../../src/core/index.ts";
import { MAX_ATTACHMENTS } from "../../infra/imageResize.ts";
import { useMediaQuery } from "../../infra/useMediaQuery.ts";
import { displayModelName } from "../../render/modelNames.ts";
import styles from "./ComposeCard.module.css";
import { ModelPickerPortal } from "./ModelPickerPortal.tsx";
import type { ImageAttachmentHandlers } from "./useImageAttachments.ts";

export interface ComposeCardProps {
	// ── Text ── controlled textarea
	value: string;
	onChange: (text: string) => void;
	/** Send: the container owns the commit (RPC + draft clearing). */
	onCommit: () => void;
	connected: boolean;
	placeholder: string;
	/** In-flight commit (Project home): send disabled, textarea stays live. */
	sending?: boolean;
	/** Focus leaving the card entirely (session: blur salvage). */
	onBlurOutside?: () => void;
	/** Escape (not consumed by completion): session collapse / edit cancel. */
	onEscape?: () => void;
	textareaRef: React.RefObject<HTMLTextAreaElement | null>;

	// ── Attachments ──
	images: ImageContent[];
	onRemoveImage: (index: number) => void;
	onFiles: (files: Iterable<File>) => void;
	onPaste: (e: React.ClipboardEvent) => void;
	isDragOver: boolean;
	dragHandlers: ImageAttachmentHandlers;
	/** Attach disabled (edit mode carries the edited entry's images). */
	attachDisabled?: boolean;
	attachTitle?: string;

	// ── Session overlays ──
	/** Non-null renders the edit header (label text). */
	editLabel?: string | null;
	onCancelEdit?: () => void;
	pendingSteer?: string[];
	onDiscardSteer?: () => void;

	// ── Busy / stop ──
	/** Stop button visible (streaming or compacting). */
	isBusy?: boolean;
	/** Send disabled (compaction blocks sends; steering does not). */
	isCompacting?: boolean;
	onStop?: () => void;

	// ── Model picker ──
	model: ModelRef | null;
	models: ModelInfo[];
	scopedModels: ScopedModelInfo[];
	thinkingLevel: string;
	thinkingLevels: string[];
	onSetModel: (provider: string, modelId: string) => void;
	onSetThinkingLevel?: (level: string) => void;
	onCycleModel: (direction: "forward" | "backward") => void;

	// ── Slots ──
	/** Left control group (session: context % + bar + cost). */
	leftControls?: ReactNode;
	/** Completion dropdown (rendered above the card; see usePathCompletion). */
	completion?: ReactNode;
	/** Pre-send key hook (completion navigation). Returns true when consumed. */
	beforeKeyDown?: (e: React.KeyboardEvent) => boolean;
}

export const ComposeCard = memo(function ComposeCard({
	value,
	onChange,
	onCommit,
	connected,
	placeholder,
	sending = false,
	onBlurOutside,
	onEscape,
	textareaRef,
	images,
	onRemoveImage,
	onFiles,
	onPaste,
	isDragOver,
	dragHandlers,
	attachDisabled = false,
	attachTitle,
	editLabel = null,
	onCancelEdit,
	pendingSteer = [],
	onDiscardSteer,
	isBusy = false,
	isCompacting = false,
	onStop,
	model,
	models,
	scopedModels,
	thinkingLevel,
	thinkingLevels,
	onSetModel,
	onSetThinkingLevel,
	onCycleModel,
	leftControls,
	completion,
	beforeKeyDown,
}: ComposeCardProps) {
	// Soft keyboards (coarse pointer) use Enter to insert a newline; sending
	// is via the button. Physical keyboards (fine pointer) keep Enter-to-send.
	const finePointer = useMediaQuery("(pointer: fine)");

	const cardRef = useRef<HTMLDivElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// Model picker portal state
	const [portalOpen, setPortalOpen] = useState(false);
	const [portalAnchor, setPortalAnchor] = useState<DOMRect | null>(null);
	const pickerBtnRef = useRef<HTMLButtonElement>(null);

	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			onChange(e.target.value);
		},
		[onChange],
	);

	const hasContent = value.trim().length > 0 || images.length > 0;
	const handleSend = useCallback(() => {
		if (!hasContent) return;
		onCommit();
	}, [hasContent, onCommit]);

	// Focus moving to something inside the card (e.g. the attach button or
	// the hidden file input keeping the click chain inside) is not a blur.
	const handleBlur = useCallback(
		(e: React.FocusEvent) => {
			if (cardRef.current?.contains(e.relatedTarget as Node)) return;
			onBlurOutside?.();
		},
		[onBlurOutside],
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (beforeKeyDown?.(e)) return;

			if (e.ctrlKey && e.key === "p") {
				e.preventDefault();
				onCycleModel(e.shiftKey ? "backward" : "forward");
				return;
			}

			if (e.key === "Enter" && !e.shiftKey) {
				// IME composition: Enter confirms the composition, not a send.
				if (e.nativeEvent.isComposing) return;
				// Soft keyboards fall through to the default newline insertion;
				// physical keyboards send.
				if (finePointer) {
					e.preventDefault();
					handleSend();
				}
			} else if (e.key === "Escape") {
				e.preventDefault();
				onEscape?.();
			}
		},
		[beforeKeyDown, onCycleModel, finePointer, handleSend, onEscape],
	);

	// The daemon reports capabilities from the model manifest. Keep the
	// global list only for older daemons that do not send capabilities yet.
	const selectedModel = model
		? models.find((m) => m.provider === model.provider && m.id === model.modelId)
		: undefined;
	const availableThinkingLevels = selectedModel?.supportedThinkingLevels ?? thinkingLevels;
	const modelName = model?.modelId ? displayModelName(model.provider, model.modelId, models) : "none";

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: layout container is the card's drop target; drag affordances have no ARIA role
		<div
			className={styles.composerCard}
			ref={cardRef}
			data-dragover={isDragOver || undefined}
			onDragEnter={dragHandlers.onDragEnter}
			onDragOver={dragHandlers.onDragOver}
			onDragLeave={dragHandlers.onDragLeave}
			onDrop={dragHandlers.onDrop}
		>
			{/* Hidden file input for the attach button (kept in the DOM so the
			    click() focus chain stays inside the card for blur handling). */}
			<input
				ref={fileInputRef}
				type="file"
				accept="image/png,image/jpeg,image/webp,image/gif"
				multiple
				className={styles.attachInput}
				tabIndex={-1}
				aria-hidden="true"
				onChange={(e) => {
					if (e.target.files) onFiles(e.target.files);
					e.target.value = ""; // allow re-selecting the same file
				}}
			/>
			{completion}

			<div className={styles.composerBody}>
				{editLabel !== null && (
					<div className={styles.editHeader}>
						<span className={styles.editHeaderLabel}>{editLabel}</span>
						<button
							type="button"
							className={styles.editCancelBtn}
							onClick={onCancelEdit}
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
				{images.length > 0 && (
					<div className={styles.attachChips}>
						{images.map((img, i) => (
							<span key={`${i}:${img.mimeType}:${img.data.length}`} className={styles.attachChip}>
								<img className={styles.attachThumb} src={`data:${img.mimeType};base64,${img.data}`} alt="" />
								<button
									type="button"
									className={styles.attachRemove}
									onClick={() => onRemoveImage(i)}
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
					value={value}
					onChange={handleChange}
					onKeyDown={handleKeyDown}
					onBlur={handleBlur}
					onPaste={onPaste}
					placeholder={placeholder}
					readOnly={!connected}
				/>

				{/* Control row. Left group ordered context-first (pct, bar, cost):
				   context is the actionable metric, cost is a ledger. Mobile and
				   desktop share this layout; the breakpoint only hides the bar and
				   swaps the model name for a fixed "Models" label (CSS-driven). */}
				<div className={styles.composerControlRow}>
					<div className={styles.composerControlLeft}>
						<button
							type="button"
							className={styles.attachBtn}
							onClick={() => fileInputRef.current?.click()}
							disabled={!connected || attachDisabled || images.length >= MAX_ATTACHMENTS}
							aria-label="Attach image"
							title={attachTitle ?? "Attach image (or paste / drag-drop)"}
						>
							📎
						</button>
						{leftControls}
					</div>

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
							   label on narrow screens. */}
							<span className={styles.composerModelName}>
								{modelName}
								{model && thinkingLevel ? (
									<span className={styles.composerModelMuted}> {thinkingLevel}</span>
								) : null}
							</span>
							<span className={styles.composerModelMobileLabel}>Models</span>
							<span className={styles.composerModelChevron} aria-hidden="true">
								▾
							</span>
						</button>

						{/* Send is always available: during streaming it queues a steer;
						    when idle it starts a normal turn. Disabled when
						    disconnected, empty, compacting, or mid-commit. Stop appears
						    alongside Send during streaming/compaction. */}
						<button
							type="button"
							className={styles.composerSendBtn}
							onClick={handleSend}
							disabled={!connected || !hasContent || isCompacting || sending}
							aria-label="Send"
							title="Send"
						>
							➤
						</button>
						{isBusy && onStop && (
							<button
								type="button"
								className={styles.composerStopBtn}
								onClick={onStop}
								aria-label="Stop"
								title="Stop"
							>
								■
							</button>
						)}
					</div>
				</div>
			</div>

			{/* Model picker portal */}
			{portalOpen && (
				<ModelPickerPortal
					anchorRect={portalAnchor}
					models={models}
					scopedModels={scopedModels}
					thinkingLevels={availableThinkingLevels}
					currentModelRef={model ?? { provider: "", modelId: "" }}
					currentThinkingLevel={thinkingLevel}
					onSelectModel={(provider, modelId) => {
						onSetModel(provider, modelId);
						setPortalOpen(false);
					}}
					onSelectThinkingLevel={(level) => {
						onSetThinkingLevel?.(level);
					}}
					onClose={() => setPortalOpen(false)}
				/>
			)}
		</div>
	);
});
