// ActionGroupView — a maximal group of consecutive action steps rendered as
// a flat vertical list (no tree branching). The group is a neutral meta-group:
// its header carries a triangle-at-start fold, a left-edge family dot
// legend (always visible), and the categorized summary. The header
// summarizes tool actions only — thinking steps are invisible until the
// group is expanded. Group fold state:
// expandedActionGroups keyed by the first step's "${entryId}:${blockIndex}".
// Effective expanded state (ADR 07):
//   expanded.has(key) || (isStreaming && isTrailing && !frozen.has(key))
//
// A single-step group renders the same header as a multi-step group — one
// dot, the step's own summary — so a lone action rests in the same collapsed
// dot-row state as a folded group. Opening it auto-expands the lone step's
// details (store-side) so the band shows without a second click.

import { memo, useCallback, useMemo } from "react";
import {
	type ActionFamily,
	type ActionKind,
	type ActionStepVM,
	kindFamily,
	kindForTool,
	stepWants,
	type ToolActionStepVM,
} from "../../../../src/viewmodel/index.ts";
import { useStore } from "../../infra/store.tsx";
import { wantPull } from "../../infra/wants.ts";
import styles from "./conversation.module.css";
import type { StepSummaryItem } from "./formatGroupSummary.ts";
import { formatGroupSummary } from "./formatGroupSummary.ts";
import { ThinkActionStepView } from "./ThinkActionStepView.tsx";
import { ToolActionStepView } from "./ToolActionStepView.tsx";

/** Distinct color families in a group, in stable precedence order. Used for
 * the left-edge dot legend so it reads consistently (order matches
 * formatGroupSummary's category order, collapsed via family). Thinking
 * steps are excluded — the header surfaces tool actions only. */
function groupFamilies(steps: ActionStepVM[]): ActionFamily[] {
	const seen = new Set<ActionFamily>();
	for (const s of steps) {
		if (s.blockType === "thinking") continue;
		const kind: ActionKind = kindForTool((s as ToolActionStepVM).toolName);
		seen.add(kindFamily(kind));
	}
	// Stable display order: mutate, bash, read (matches the label
	// precedence edit > write > bash > read, collapsed via family).
	const order: ActionFamily[] = ["mutate", "bash", "read"];
	return order.filter((f) => seen.has(f));
}

export const ActionGroupView = memo(function ActionGroupView({
	groupKey,
	steps,
	isTrailing,
	onToggleGroup,
	onToggleStep,
}: {
	groupKey: string;
	steps: ActionStepVM[];
	isTrailing: boolean;
	onToggleGroup: (key: string, cardKeys: string[]) => void;
	onToggleStep: (key: string) => void;
}) {
	const isExpanded = useStore(useCallback((s) => s.expandedActionGroups.has(groupKey), [groupKey]));
	const isFrozen = useStore(useCallback((s) => s.frozenActionGroups.has(groupKey), [groupKey]));

	// ADR 09: the collapsed header names only edit/write files — bash and
	// read render as counts, which need no arguments — so only those kinds
	// pull `arguments` at group level. Step views register their own
	// arguments wants when rendered (ToolActionStepView), so expanded rows
	// keep their live summaries.
	// The pullTick subscription re-registers wants after pull failures and
	// refreshes summaries after ingests.
	useStore((s) => s.pullTick);
	wantPull(
		steps.flatMap((s) => {
			if (s.blockType !== "tool") return [];
			const kind = kindForTool((s as ToolActionStepVM).toolName);
			return kind === "edit" || kind === "write" ? stepWants(s, false) : [];
		}),
	);

	// During streaming, the trailing group auto-expands — steps appear,
	// details stay folded — unless the user froze it by toggling manually.
	const effectiveExpanded = isExpanded || (isTrailing && !isFrozen);

	// Compute the label from live store data so it updates as tool call
	// arguments stream in (the VM cache key does not include argument values).
	// Only the path basename is extracted — edit/write are the sole named
	// categories; every other tool is counted by name alone.
	const label = useStore(
		useCallback(
			(s) => {
				const entries = s.document.entries;
				const items: StepSummaryItem[] = steps.map((h) => {
					if (h.blockType === "thinking") {
						return { toolName: "thinking", basename: null };
					}
					const entry = entries[h.entryId];
					const block = entry?.kind === "message" ? entry.content[h.blockIndex] : null;
					const liveArgs = block?.type === "toolCall" ? block.arguments : (h as ToolActionStepVM).arguments;
					const recArgs =
						liveArgs !== null && typeof liveArgs === "object" ? (liveArgs as Record<string, unknown>) : null;
					const rawPath = recArgs ? ((recArgs.path as string) ?? (recArgs.filePath as string) ?? null) : null;
					return {
						toolName: (h as ToolActionStepVM).toolName,
						basename: rawPath ? rawPath.split("/").pop() || rawPath : null,
					};
				});
				return formatGroupSummary(items);
			},
			[steps],
		),
	);

	const families = useMemo(() => groupFamilies(steps), [steps]);

	return (
		<div className={styles.actionGroup}>
			<button
				type="button"
				className={styles.actionGroupHeader}
				onClick={() =>
					onToggleGroup(
						groupKey,
						steps.map((h) => `${h.entryId}:b${h.blockIndex}`),
					)
				}
				aria-expanded={effectiveExpanded}
				aria-label={`${effectiveExpanded ? "Collapse" : "Expand"} action group: ${label}`}
			>
				<span className={styles.foldTri}>{effectiveExpanded ? "\u25BE" : "\u25B8"}</span>
				{/* Left-edge family legend — always visible (stable landmark;
				    the bands below are the expanded detail, the dots are the
				    summary). One dot per color family, same --kind-* tokens as
				    the band strips/tints. */}
				{families.length > 0 && (
					<span className={styles.groupSwatches}>
						{families.map((f) => (
							<span key={f} data-family={f} />
						))}
					</span>
				)}
				<span className={styles.actionGroupSummary}>{label}</span>
			</button>
			{effectiveExpanded && (
				<div className={styles.spine}>
					{steps.map((h) =>
						h.blockType === "thinking" ? (
							<ThinkActionStepView key={`${h.entryId}:${h.blockIndex}`} step={h} onToggleStep={onToggleStep} />
						) : (
							<ToolActionStepView key={`${h.entryId}:${h.blockIndex}`} step={h} onToggleStep={onToggleStep} />
						),
					)}
				</div>
			)}
		</div>
	);
});
