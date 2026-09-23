// ============================================================================
// ModelPickerPortal — floating searchable model selector, grouped by provider.
// Anchored to the picker button's bounding rect. Includes a thinking-level
// pill row at the top (pi-sitter style).
// ============================================================================

import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelInfo, ModelRef, PinnedModelInfo } from "../../../../src/core/index.ts";
import { isModelSelected } from "../../../../src/viewmodel/index.ts";
import styles from "./ComposeCard.module.css";
import { buildModelGroups, type ModelGroup } from "./modelGroups.ts";

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

/** Push-pin glyph: filled = pinned, outline = unpinned. The glyph is state
 * only — hover styling lives on the button surface, never on the symbol. */
function PinIcon({ filled }: { filled: boolean }) {
	return (
		<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<path
				d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z"
				fill={filled ? "currentColor" : "none"}
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinejoin="round"
			/>
		</svg>
	);
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
	onTogglePin,
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
	/** Pin or unpin one model in the daemon-global list (ADR 15). */
	onTogglePin: (provider: string, modelId: string, pinned: boolean) => void;
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

	// Freeze the grouping for the portal's lifetime: pinning must not move a row
	// out from under the cursor, so the catalogue re-partitions only on the next
	// open. The live `pinnedModels` still drives each row's pin state.
	const [groupingPinned] = useState(pinnedModels);
	const groups = useMemo(
		() => buildModelGroups({ models, pinnedModels: groupingPinned, visibleModels, search }),
		[models, groupingPinned, visibleModels, search],
	);
	// Per-group reveal state: an expanded group shows its folded tail in place
	// of its `More…` row. One-shot (no collapse); reset when the query changes.
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

	const pinnedKeys = useMemo(() => new Set(pinnedModels.map((m) => `${m.provider}/${m.id}`)), [pinnedModels]);

	const expandGroup = (key: string) => setExpanded((prev) => new Set(prev).add(key));

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

	const renderRow = (m: ModelInfo | PinnedModelInfo) => {
		const flatIdx = flatItems.findIndex((f) => f.kind === "model" && f.model === m);
		const isSelected = isModelSelected(m, currentModelRef);
		const isFocused = flatIdx === focusIdx;
		const isPinned = pinnedKeys.has(`${m.provider}/${m.id}`);
		let cls = styles.portalItem;
		if (isSelected) cls += ` ${styles.portalItemSelected}`;
		if (isFocused) cls += ` ${styles.portalItemFocused}`;
		return (
			<div key={`${m.provider}/${m.id}`} className={cls} data-flat-idx={flatIdx}>
				<button
					type="button"
					className={styles.portalItemSelect}
					title={`${m.provider}/${m.id}`}
					onMouseEnter={() => setFocusIdx(flatIdx)}
					onClick={() => onSelectModel(m.provider, m.id)}
				>
					<span className={styles.portalItemName}>{m.name}</span>
				</button>
				<button
					type="button"
					className={`${styles.portalPin} ${isPinned ? styles.portalPinActive : ""}`}
					tabIndex={-1}
					aria-label={isPinned ? `Unpin ${m.name}` : `Pin ${m.name}`}
					title={isPinned ? "Unpin" : "Pin"}
					onClick={() => onTogglePin(m.provider, m.id, !isPinned)}
				>
					<PinIcon filled={isPinned} />
				</button>
			</div>
		);
	};

	const renderGroup = (g: ModelGroup) => {
		const isExpanded = expanded.has(g.key);
		const moreIdx = flatItems.findIndex((f) => f.kind === "more" && f.groupKey === g.key);
		return (
			<div key={g.key} className={styles.portalGroup}>
				<div className={styles.portalGroupHeader}>{g.label}</div>
				{g.items.map(renderRow)}
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
				{isExpanded && g.folded.map(renderRow)}
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
					const key = `${item.model.provider}/${item.model.id}`;
					onTogglePin(item.model.provider, item.model.id, !pinnedKeys.has(key));
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
