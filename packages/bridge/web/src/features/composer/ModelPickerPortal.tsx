// ============================================================================
// ModelPickerPortal — floating searchable model selector, grouped by provider.
// Anchored to the picker button's bounding rect. Includes a thinking-level
// pill row at the top (pi-sitter style).
// ============================================================================

import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelInfo, ModelRef, ScopedModelInfo } from "../../../../src/core/index.ts";
import { isModelSelected } from "../../../../src/viewmodel/index.ts";
import { displayProviderName } from "../../render/modelNames.ts";
import styles from "./ComposeCard.module.css";

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
	scopedModels,
	thinkingLevels,
	currentModelRef,
	currentThinkingLevel,
	onSelectModel,
	onSelectThinkingLevel,
	onClose,
	anchorRect,
}: {
	models: ModelInfo[];
	scopedModels: ScopedModelInfo[];
	thinkingLevels: string[];
	currentModelRef: ModelRef;
	currentThinkingLevel: string;
	onSelectModel: (provider: string, modelId: string) => void;
	onSelectThinkingLevel: (level: string) => void;
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

	const curatedModels = useMemo(() => {
		if (scopedModels.length > 0) return scopedModels;
		return models.reduce<{ provider: string; id: string; name: string }[]>((acc, m) => {
			if (!acc.find((x) => x.provider === m.provider)) {
				acc.push({ provider: m.provider, id: m.id, name: m.name });
			}
			return acc;
		}, []);
	}, [scopedModels, models]);

	const scopedKeys = useMemo(() => new Set(scopedModels.map((sm) => `${sm.provider}/${sm.id}`)), [scopedModels]);

	const filtered = useMemo(() => {
		const base = search.trim()
			? models.filter(
					(m) =>
						m.name.toLowerCase().includes(search.toLowerCase()) ||
						m.provider.toLowerCase().includes(search.toLowerCase()) ||
						m.id.toLowerCase().includes(search.toLowerCase()),
				)
			: models;
		// Browsing (not searching) with a pinned scope: pinned models
		// already appear under "Pinned", so drop them from provider
		// groups so each model appears exactly once. While searching
		// the curated group is hidden and every model must stay
		// findable in its provider group, so no dedup.
		if (!search.trim() && scopedKeys.size > 0) {
			return base.filter((m) => !scopedKeys.has(`${m.provider}/${m.id}`));
		}
		return base;
	}, [models, search, scopedKeys]);

	// Build groups: curated section first (when not searching), then provider
	// groups. Group header shows the provider display name (Provider registry
	// name via ModelInfo.providerName, with capitalization fallback); the raw
	// provider id stays as the React key.
	const groups: { provider: string; label: string; items: (ModelInfo | ScopedModelInfo)[] }[] = [];
	if (!search.trim() && curatedModels.length > 0) {
		const curatedLabel = scopedModels.length > 0 ? "Pinned" : "Suggested";
		groups.push({ provider: curatedLabel, label: curatedLabel, items: curatedModels });
	}
	const seen = new Set<string>();
	for (const m of filtered) {
		if (!seen.has(m.provider)) {
			seen.add(m.provider);
			groups.push({ provider: m.provider, label: displayProviderName(m.provider, models), items: [] });
		}
		groups[groups.length - 1].items.push(m);
	}
	// Provider groups sorted ascending by item count: providers with fewer
	// models come first, so niche providers are not buried under large
	// catalogs. Stable sort — ties keep catalog order. The curated group
	// stays pinned at the top.
	const curated = groups.filter((g) => g.provider === "Pinned" || g.provider === "Suggested");
	const providerGroups = groups
		.filter((g) => g.provider !== "Pinned" && g.provider !== "Suggested")
		.sort((a, b) => a.items.length - b.items.length);
	groups.length = 0;
	groups.push(...curated, ...providerGroups);

	// Unified flatItems for keyboard navigation — includes curated items first
	const flatItems: { kind: "curated" | "model"; model: ModelInfo | ScopedModelInfo }[] = [];
	for (const g of groups) {
		for (const m of g.items) {
			flatItems.push({
				kind: g.provider === "Pinned" || g.provider === "Suggested" ? "curated" : "model",
				model: m,
			});
		}
	}

	// Sync focusIdx to the current model on mount and when the list/provider changes
	// biome-ignore lint/correctness/useExhaustiveDependencies: flatItems is derived from search (via filtered), so search is needed to re-sync on search clear/change
	useEffect(() => {
		const idx = Math.max(
			0,
			flatItems.findIndex((fi) => "id" in fi.model && isModelSelected(fi.model, currentModelRef)),
		);
		setFocusIdx(idx);
	}, [currentModelRef, search]);

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
			case "Enter":
				e.preventDefault();
				if (flatItems[focusIdx]) {
					const mi = flatItems[focusIdx].model;
					onSelectModel(mi.provider, mi.id);
				}
				break;
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
						placeholder="Search models..."
						value={search}
						onChange={(e) => {
							setSearch(e.target.value);
						}}
					/>
				</div>

				<div className={styles.portalList} ref={listRef}>
					{flatItems.length === 0 && <div className={styles.portalNoMatch}>No models match</div>}
					{groups.map((g) => (
						<div key={g.provider} className={styles.portalGroup}>
							<div className={styles.portalGroupHeader}>{g.label}</div>
							{g.items.map((m) => {
								const flatIdx = flatItems.findIndex((f) => f.model === m);
								const isSelected = isModelSelected(m, currentModelRef);
								const isFocused = flatIdx === focusIdx;
								let cls = styles.portalItem;
								if (isSelected) cls += ` ${styles.portalItemSelected}`;
								if (isFocused) cls += ` ${styles.portalItemFocused}`;
								return (
									<button
										key={m.id}
										type="button"
										className={cls}
										data-flat-idx={flatIdx}
										onClick={() => onSelectModel(m.provider, m.id)}
										onMouseEnter={() => setFocusIdx(flatIdx)}
									>
										{m.name}
									</button>
								);
							})}
						</div>
					))}
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
