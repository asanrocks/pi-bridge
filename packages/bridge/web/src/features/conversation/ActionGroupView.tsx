// ActionGroupView — a maximal group of consecutive action steps rendered as
// a flat vertical list (no tree branching). The group is a neutral meta-group:
// its header carries a triangle-at-start fold, a left-edge family dot
// legend (always visible), and the categorized summary. Group fold state:
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
 * formatGroupSummary's category order, collapsed via family). */
function groupFamilies(steps: ActionStepVM[]): ActionFamily[] {
	const seen = new Set<ActionFamily>();
	for (const s of steps) {
		const kind: ActionKind = s.blockType === "thinking" ? "think" : kindForTool((s as ToolActionStepVM).toolName);
		seen.add(kindFamily(kind));
	}
	// Stable display order: mutate, bash, read, think (matches the label
	// precedence edit > write > bash > read > think, collapsed via family).
	const order: ActionFamily[] = ["mutate", "bash", "read", "think"];
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

	// ADR 09: step summaries render tool summaries, so this component wants
	// `arguments` for every tool step in the group — expanded or not.
	// The pullTick subscription re-registers wants after pull failures and
	// refreshes summaries after ingests.
	useStore((s) => s.pullTick);
	wantPull(steps.flatMap((s) => (s.blockType === "tool" ? stepWants(s, false) : [])));

	// During streaming, the trailing group auto-expands — steps appear,
	// details stay folded — unless the user froze it by toggling manually.
	const effectiveExpanded = isExpanded || (isTrailing && !isFrozen);

	// Compute the label from live store data so it updates as tool call
	// arguments stream in (the VM cache key does not include argument values).
	const label = useStore(
		useCallback(
			(s) => {
				const entries = s.document.entries;
				const items: StepSummaryItem[] = steps.map((h) => {
					if (h.blockType === "thinking") {
						return { toolName: "thinking", basename: null, command: null };
					}
					const entry = entries[h.entryId];
					const block = entry?.kind === "message" ? entry.content[h.blockIndex] : null;
					const liveArgs = block?.type === "toolCall" ? block.arguments : (h as ToolActionStepVM).arguments;
					const toolName = (h as ToolActionStepVM).toolName;
					const recArgs =
						liveArgs !== null && typeof liveArgs === "object" ? (liveArgs as Record<string, unknown>) : null;
					let basename: string | null = null;
					let command: string | null = null;
					if (recArgs) {
						const rawPath = (recArgs.path as string) ?? (recArgs.filePath as string) ?? null;
						if (rawPath) {
							basename = rawPath.split("/").pop() || rawPath;
						}
						if (toolName === "bash") {
							command = (recArgs.command as string) ?? null;
						}
					}
					return { toolName, basename, command };
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
