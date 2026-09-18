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
	type GitChangeMark,
	kindFamily,
	kindForTool,
	stepWants,
	type ToolActionStepVM,
} from "../../../../src/viewmodel/index.ts";
import { wantPull } from "../../infra/net/wants.ts";
import { useStore } from "../../infra/state/store.tsx";
import styles from "./actionSteps.module.css";
import type { StepSummaryItem } from "./formatGroupSummary.ts";
import { formatGroupSummary } from "./formatGroupSummary.ts";
import { GitChangeCard } from "./GitChangeCard.tsx";
import { ThinkActionStepView } from "./ThinkActionStepView.tsx";
import { ToolActionStepView } from "./ToolActionStepView.tsx";

/** Swatch entries for the left-edge dot legend: tool families (in stable
 * precedence order, matching formatGroupSummary's category order) plus the
 * meta "git" entry first when the group holds mid-run git marks. Thinking
 * steps are excluded — the header surfaces tool actions only. */
function groupSwatches(steps: ActionStepVM[], gitChanges: GitChangeMark[] | undefined): (ActionFamily | "git")[] {
	const seen = new Set<ActionFamily>();
	for (const s of steps) {
		if (s.blockType === "thinking") continue;
		const kind: ActionKind = kindForTool((s as ToolActionStepVM).toolName);
		seen.add(kindFamily(kind));
	}
	// Stable display order: git (meta, first — highest precedence, matching
	// the summary), then mutate, bash, read (the tool label precedence
	// edit > write > bash > read, collapsed via family).
	const order: ActionFamily[] = ["mutate", "bash", "read"];
	const families = order.filter((f) => seen.has(f));
	return (gitChanges?.length ?? 0) > 0 ? ["git", ...families] : families;
}

export const ActionGroupView = memo(function ActionGroupView({
	groupKey,
	steps,
	gitChanges,
	isTrailing,
	onToggleGroup,
	onToggleStep,
}: {
	groupKey: string;
	steps: ActionStepVM[];
	/** ADR 10 v2: mid-run git marks assigned to this group — the summary
	 * gains a "git:" segment and each renders as its own card in the spine
	 * after the step it follows. */
	gitChanges?: GitChangeMark[];
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
				return formatGroupSummary(
					items,
					gitChanges?.map((c) => c.identity),
				);
			},
			[steps, gitChanges],
		),
	);

	const families = useMemo(() => groupSwatches(steps, gitChanges), [steps, gitChanges]);

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
				    the band strips/tints. Git leads when present (highest
				    precedence, matching the summary's category order). */}
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
					{steps.map((h) => (
						<div key={`${h.entryId}:${h.blockIndex}`}>
							{h.blockType === "thinking" ? (
								<ThinkActionStepView step={h} onToggleStep={onToggleStep} />
							) : (
								<ToolActionStepView step={h} onToggleStep={onToggleStep} />
							)}
							{/* ADR 10 v2: the git card renders after the step it follows. */}
							{gitChanges
								?.filter((c) => c.afterBlockKey === `${h.entryId}:b${h.blockIndex}`)
								.map((c) => (
									<GitChangeCard key={c.entryId} change={c} />
								))}
						</div>
					))}
					{/* Marks whose anchor block is not a step of this group (e.g. a
					    trailing turn_end stamp after a closing text block, assigned here
					    as the turn's last group) render after the last step. */}
					{gitChanges
						?.filter((c) => !steps.some((h) => c.afterBlockKey === `${h.entryId}:b${h.blockIndex}`))
						.map((c) => (
							<GitChangeCard key={c.entryId} change={c} />
						))}
				</div>
			)}
		</div>
	);
});
