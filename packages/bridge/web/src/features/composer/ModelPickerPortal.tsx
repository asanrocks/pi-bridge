// ============================================================================
// ModelPickerPortal — floating searchable model selector, grouped by provider.
// Anchored to the picker button's bounding rect. Includes a thinking-level
// pill row at the top (pi-sitter style).
//
// Pinned membership and order are edited here and sent as the whole list (ADR
// 20): a pin appends to the tail, so a new pin never becomes the default; a
// drag inside the curated group reorders it, and the head — the default for a
// fresh Session — is marked. Membership stays frozen for the portal's lifetime
// (a pin must not move a row under the cursor); order is live. Reordering is
// pointer-only (ADR 20): the grip drag is the one gesture that moves a row.
// ============================================================================

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type {
	ModelInfo,
	ModelRef,
	PinnedModelInfo,
	PinnedModelSelection,
	RpcReply,
} from "../../../../src/core/index.ts";
import { isModelSelected } from "../../../../src/viewmodel/index.ts";
import { GripIcon, PinIcon } from "../../render/icons.tsx";
import styles from "./ComposeCard.module.css";
import { buildModelGroups, type ModelGroup } from "./modelGroups.ts";
import { movePinnedEntry, pinnedSelectionsOf, withPinned } from "./pinnedEdit.ts";

/** Keyboard-navigable rows: a model row, or a group's `More…` row. */
type FlatItem = { kind: "model"; model: ModelInfo | PinnedModelInfo } | { kind: "more"; groupKey: string };

/** Anchor the portal above the button (the session dock's position), or
 * flip below it when there is no room above (the Project home's centered
 * card, short viewports). The downward case also clamps the height so the
 * portal never runs off the bottom of the screen. */
function portalPosition(anchor: DOMRect): React.CSSProperties {
	const left = Math.max(8, Math.min(anchor.left, window.innerWidth - 320 - 8));
	const roomAbove = anchor.top;
	if (roomAbove >= 368) {
		// 360 max-height + 4px gap + slack
		return { position: "fixed", bottom: window.innerHeight - anchor.top + 4, left, width: 320 };
	}
	const maxHeight = Math.max(96, window.innerHeight - anchor.bottom - 12);
	return { position: "fixed", top: anchor.bottom + 4, left, width: 320, maxHeight };
}

export function ModelPickerPortal({
	models,
	pinnedModels,
	visibleModels,
	thinkingLevels,
	currentModelRef,
	currentThinkingLevel,
	onSelectModel,
	onSelectThinkingLevel,
	onSetPinnedModels,
	onClose,
	anchorRect,
}: {
	models: ModelInfo[];
	pinnedModels: PinnedModelInfo[];
	/** Resolved `provider/modelId` keys of the normal tier (ADR 15); empty =
	 * no folding. */
	visibleModels: string[];
	thinkingLevels: string[];
	currentModelRef: ModelRef;
	currentThinkingLevel: string;
	onSelectModel: (provider: string, modelId: string) => void;
	onSelectThinkingLevel: (level: string) => void;
	/** Replace the daemon-global pinned list with this ordered list (ADR 20):
	 * pinning, unpinning, and reordering all send the whole list. Resolves
	 * with the RPC reply — a refused replacement (`ok: false` or a
	 * rejection) rolls the portal's copy back. */
	onSetPinnedModels: (models: PinnedModelSelection[]) => Promise<RpcReply | undefined>;
	onClose: () => void;
	anchorRect: DOMRect | null;
}) {
	const [search, setSearch] = useState("");
	const listRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	const [focusIdx, setFocusIdx] = useState(0);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	// Scroll the focused item into view when focusIdx changes
	useEffect(() => {
		const el = listRef.current?.querySelector(`[data-flat-idx="${focusIdx}"]`) as HTMLElement | undefined;
		el?.scrollIntoView({ block: "nearest" });
	}, [focusIdx]);

	// The portal owns a copy of the pinned list for its lifetime, seeded at open.
	// Membership must not move a row out from under the cursor, and the edits are
	// the list itself (ADR 20), so this copy is what the rows render and what the
	// next replacement sends; the pushed result is the verdict for other clients.
	// A pin another client makes while this picker is open is the documented
	// last-writer-wins window, not something a half-reconciled copy should paper
	// over.
	const [pinnedRows, setPinnedRows] = useState<PinnedModelInfo[]>(pinnedModels);
	// Rebuild the catalogue only from the row set, so an edit (append, remove,
	// move) repartitions the list in place: the pinned group is the order the
	// user is editing, and a pin stays promoted to the normal tier.
	const pinnedInfoByKey = useMemo(() => {
		const info = new Map<string, PinnedModelInfo>();
		for (const model of models) {
			info.set(`${model.provider}/${model.id}`, {
				provider: model.provider,
				id: model.id,
				name: model.name,
			});
		}
		for (const model of pinnedModels) info.set(`${model.provider}/${model.id}`, model);
		for (const model of pinnedRows) info.set(`${model.provider}/${model.id}`, model);
		return info;
	}, [models, pinnedModels, pinnedRows]);
	const rowFor = (selection: PinnedModelSelection): PinnedModelInfo => {
		const known = pinnedInfoByKey.get(`${selection.provider}/${selection.id}`);
		if (known) return known;
		return {
			provider: selection.provider,
			id: selection.id,
			name: selection.id,
			...(selection.thinkingLevel === undefined ? {} : { thinkingLevel: selection.thinkingLevel }),
		};
	};
	const groups = useMemo(
		() => buildModelGroups({ models, pinnedModels: pinnedRows, visibleModels, search }),
		[models, pinnedRows, visibleModels, search],
	);
	// Per-group reveal state: an expanded group shows its folded tail in place
	// of its `More…` row. One-shot (no collapse); reset when the query changes.
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

	const pinnedKeys = useMemo(() => new Set(pinnedRows.map((m) => `${m.provider}/${m.id}`)), [pinnedRows]);

	const expandGroup = (key: string) => setExpanded((prev) => new Set(prev).add(key));

	// ── Pinned order editing (ADR 20) ──────────────────────────────────
	// Every edit is a pure list transformation over the rendered order (see
	// pinnedEdit.ts) applied to the local copy and sent whole.
	const renderedPinned = useMemo(() => pinnedSelectionsOf(pinnedRows), [pinnedRows]);
	const pinnedRowRefs = useRef(new Map<string, HTMLDivElement>());
	// `slot` is an insertion point in the rendered list (0..n); the move target
	// is the index in the list after removal, derived at commit.
	const [drag, setDrag] = useState<{ from: number; slot: number } | null>(null);
	const dragRef = useRef<{ from: number; slot: number; pointerId: number } | null>(null);

	const pinnedKeyAt = (index: number): string | null => {
		const entry = renderedPinned[index];
		return entry ? `${entry.provider}/${entry.id}` : null;
	};

	/** The insertion slot nearest `clientY` among the rendered pinned rows. */
	const dropSlotAt = (clientY: number): number => {
		for (let index = 0; index < renderedPinned.length; index += 1) {
			const key = pinnedKeyAt(index);
			const element = key === null ? undefined : pinnedRowRefs.current.get(key);
			if (!element) continue;
			const rect = element.getBoundingClientRect();
			if (clientY < rect.top + rect.height / 2) return index;
		}
		return renderedPinned.length;
	};

	const sendPinned = async (selections: PinnedModelSelection[]) => {
		const before = pinnedRows;
		setPinnedRows(selections.map(rowFor));
		const reply = await onSetPinnedModels(selections);
		// The copy is a cache of the daemon's list, not a log of intents: a
		// refused replacement (a rejected RPC or `ok: false` — useRpc toasts)
		// reverts it, so the rows never keep rendering an order the scope never
		// accepted. A filtered-but-accepted replacement (the daemon dropped an
		// unresolvable entry) is the proposal/verdict design, not this path.
		if (!reply?.ok) setPinnedRows(before);
	};

	const commitOrder = (from: number, slot: number) => {
		const to = slot > from ? slot - 1 : slot;
		if (to === from) return;
		sendPinned(movePinnedEntry(renderedPinned, from, to));
	};

	const startDrag = (event: React.PointerEvent<HTMLButtonElement>, from: number) => {
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		dragRef.current = { from, slot: from, pointerId: event.pointerId };
		setDrag({ from, slot: from });
	};

	const trackDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
		const current = dragRef.current;
		if (!current || current.pointerId !== event.pointerId) return;
		const slot = dropSlotAt(event.clientY);
		if (slot === current.slot) return;
		current.slot = slot;
		setDrag({ from: current.from, slot });
	};

	const endDrag = (event: React.PointerEvent<HTMLButtonElement>, commit: boolean) => {
		const current = dragRef.current;
		dragRef.current = null;
		if (!current || current.pointerId !== event.pointerId) return;
		setDrag(null);
		if (commit) commitOrder(current.from, current.slot);
	};

	/** Alt+Up/Down on a pinned row is deliberately NOT a reorder chord: the
	 * app's global keybindings own Alt+Arrow as active-session cycling, and a
	 * portal handler cannot stopPropagation its way out of that document
	 * listener without risking every other consumed key. Reordering is
	 * pointer-only (ADR 20); the grip drag is the one gesture that moves a row. */

	const togglePin = (model: ModelInfo | PinnedModelInfo) => {
		const key = `${model.provider}/${model.id}`;
		sendPinned(withPinned(renderedPinned, { provider: model.provider, id: model.id }, !pinnedKeys.has(key)));
	};

	// Unified flatItems for keyboard navigation — each group's shown rows, then
	// either its `More…` row or its revealed folded tail.
	const flatItems = useMemo(() => {
		const items: FlatItem[] = [];
		for (const g of groups) {
			for (const m of g.items) items.push({ kind: "model", model: m });
			if (g.folded.length === 0) continue;
			if (expanded.has(g.key)) for (const m of g.folded) items.push({ kind: "model", model: m });
			else items.push({ kind: "more", groupKey: g.key });
		}
		return items;
	}, [groups, expanded]);

	// Sync focusIdx to the current model on mount and when the query changes.
	// Deliberately NOT on `expanded`: expanding a group keeps the focused index
	// where the pointer/keyboard left it (the `More…` row's slot is taken by the
	// first revealed row), so revealing never re-centers the list and yanks the
	// scroll position.
	// biome-ignore lint/correctness/useExhaustiveDependencies: flatItems is derived from the inputs listed here; `expanded` is intentionally omitted
	useEffect(() => {
		const idx = Math.max(
			0,
			flatItems.findIndex((fi) => fi.kind === "model" && isModelSelected(fi.model, currentModelRef)),
		);
		setFocusIdx(idx);
	}, [currentModelRef, search]);

	const renderRow = (m: ModelInfo | PinnedModelInfo, pinnedIndex?: number) => {
		const key = `${m.provider}/${m.id}`;
		const flatIdx = flatItems.findIndex((f) => f.kind === "model" && f.model === m);
		const isSelected = isModelSelected(m, currentModelRef);
		const isFocused = flatIdx === focusIdx;
		const isPinned = pinnedKeys.has(key);
		const isDragging = pinnedIndex !== undefined && drag !== null && drag.from === pinnedIndex;
		// The head of the curated group is what a fresh Session starts on, so it
		// says so: otherwise "pin" would silently decide the default.
		const isDefault = pinnedIndex === 0;
		let cls = styles.portalItem;
		if (isSelected) cls += ` ${styles.portalItemSelected}`;
		if (isFocused) cls += ` ${styles.portalItemFocused}`;
		return (
			<div
				key={key}
				className={cls}
				data-flat-idx={flatIdx}
				data-cursor={isFocused || undefined}
				data-dragging={isDragging || undefined}
				ref={
					pinnedIndex === undefined
						? undefined
						: (element) => {
								if (element) pinnedRowRefs.current.set(key, element);
								else pinnedRowRefs.current.delete(key);
							}
				}
			>
				<button
					type="button"
					className={styles.portalItemSelect}
					title={`${m.provider}/${m.id}`}
					aria-current={isSelected ? "true" : undefined}
					onMouseEnter={() => setFocusIdx(flatIdx)}
					onClick={() => onSelectModel(m.provider, m.id)}
				>
					<span className={styles.portalItemName}>{m.name}</span>
					{isDefault && (
						<span className={styles.portalItemDefault} title="Fresh sessions start on this model">
							default
						</span>
					)}
				</button>
				{pinnedIndex !== undefined && (
					<button
						type="button"
						className={styles.portalGrip}
						tabIndex={-1}
						aria-label={`Reorder ${m.name}`}
						title="Drag to reorder"
						onPointerDown={(event) => startDrag(event, pinnedIndex)}
						onPointerMove={trackDrag}
						onPointerUp={(event) => endDrag(event, true)}
						onPointerCancel={(event) => endDrag(event, false)}
					>
						<GripIcon size={14} />
					</button>
				)}
				<button
					type="button"
					className={`${styles.portalPin} ${isPinned ? styles.portalPinActive : ""}`}
					tabIndex={-1}
					aria-pressed={isPinned}
					aria-label={isPinned ? `Unpin ${m.name}` : `Pin ${m.name}`}
					title={isPinned ? "Unpin" : "Pin"}
					onClick={() => togglePin(m)}
				>
					<PinIcon size={14} filled={isPinned} />
				</button>
			</div>
		);
	};

	const renderGroup = (g: ModelGroup) => {
		const isExpanded = expanded.has(g.key);
		const isCurated = g.key === "Pinned";
		const moreIdx = flatItems.findIndex((f) => f.kind === "more" && f.groupKey === g.key);
		const dropLine = (slot: number) =>
			drag !== null && drag.slot === slot ? <div className={styles.portalDropLine} /> : null;
		return (
			<div key={g.key} className={styles.portalGroup}>
				<div className={styles.portalGroupHeader}>{g.label}</div>
				{g.items.map((m, index) => (
					<Fragment key={`${m.provider}/${m.id}`}>
						{isCurated && dropLine(index)}
						{renderRow(m, isCurated ? index : undefined)}
					</Fragment>
				))}
				{isCurated && dropLine(g.items.length)}
				{g.folded.length > 0 && !isExpanded && (
					<button
						type="button"
						className={`${styles.portalMore} ${focusIdx === moreIdx ? styles.portalItemFocused : ""}`}
						data-flat-idx={moreIdx}
						onMouseEnter={() => setFocusIdx(moreIdx)}
						onClick={() => expandGroup(g.key)}
					>
						More…
					</button>
				)}
				{isExpanded && g.folded.map((m) => renderRow(m))}
			</div>
		);
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				setFocusIdx((i) => Math.min(i + 1, flatItems.length - 1));
				break;
			case "ArrowUp":
				e.preventDefault();
				setFocusIdx((i) => Math.max(i - 1, 0));
				break;
			case "Enter": {
				e.preventDefault();
				const item = flatItems[focusIdx];
				if (!item) break;
				if (item.kind === "more") {
					expandGroup(item.groupKey);
					break;
				}
				// Shift+Enter toggles the focused row's pin; plain Enter selects.
				if (e.shiftKey) {
					togglePin(item.model);
				} else {
					onSelectModel(item.model.provider, item.model.id);
				}
				break;
			}
			case "Escape":
				onClose();
				break;
		}
	};

	return (
		<>
			<button type="button" aria-label="Close model picker" className={styles.portalOverlay} onClick={onClose} />
			<div
				role="dialog"
				className={styles.portal}
				style={anchorRect ? portalPosition(anchorRect) : undefined}
				onKeyDown={handleKeyDown}
			>
				<ThinkingLevelRow levels={thinkingLevels} current={currentThinkingLevel} onSelect={onSelectThinkingLevel} />

				<div className={styles.portalSearch}>
					<input
						ref={inputRef}
						className={styles.portalSearchInput}
						type="text"
						placeholder="Search models…"
						value={search}
						onChange={(e) => {
							setSearch(e.target.value);
							setExpanded(new Set());
						}}
					/>
				</div>

				<div className={styles.portalList} ref={listRef}>
					{flatItems.length === 0 && <div className={styles.portalNoMatch}>No models match</div>}
					{groups.map(renderGroup)}
				</div>
			</div>
		</>
	);
}

// ---------------------------------------------------------------------------
// ThinkingLevelRow — pill toggle inside the model picker portal
// ---------------------------------------------------------------------------

function ThinkingLevelRow({
	levels,
	current,
	onSelect,
}: {
	levels: string[];
	current: string;
	onSelect: (level: string) => void;
}) {
	if (levels.length === 0) return null;

	// The range indexes the filtered supported-level list, not the global
	// level list. This keeps unsupported levels out of the control entirely.
	const currentIndex = Math.max(0, levels.indexOf(current));
	const selected = levels[currentIndex];

	return (
		<div className={styles.thinkingLevelRow}>
			<span className={styles.thinkingLevelLabel}>Thinking</span>
			<span className={styles.thinkingLevelValue}>{selected}</span>
			<div className={`${styles.thinkingLevelControl} ${thinkingLevelClass(selected)}`}>
				<div
					className={styles.thinkingLevelTrack}
					style={{ left: `${50 / levels.length}%`, right: `${50 / levels.length}%` }}
					aria-hidden="true"
				>
					{levels.map((level) => (
						<span key={level} className={`${styles.thinkingLevelSegment} ${thinkingLevelClass(level)}`} />
					))}
				</div>
				<input
					className={styles.thinkingLevelSlider}
					type="range"
					min={0}
					max={levels.length - 1}
					step={1}
					value={currentIndex}
					onChange={(event) => onSelect(levels[Number(event.target.value)])}
					aria-label="Thinking level"
					aria-valuetext={selected}
					style={{
						left: `${50 / levels.length}%`,
						right: `${50 / levels.length}%`,
						width: `${100 - 100 / levels.length}%`,
					}}
				/>
			</div>
		</div>
	);
}

function thinkingLevelClass(level: string): string {
	switch (level) {
		case "off":
			return styles.thinkingLevelOff;
		case "minimal":
			return styles.thinkingLevelMinimal;
		case "low":
			return styles.thinkingLevelLow;
		case "medium":
			return styles.thinkingLevelMedium;
		case "high":
			return styles.thinkingLevelHigh;
		case "xhigh":
			return styles.thinkingLevelXhigh;
		case "max":
			return styles.thinkingLevelMax;
		default:
			return styles.thinkingLevelLow;
	}
}
