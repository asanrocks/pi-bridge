// ActionGroupView — a maximal group of consecutive actions rendered as
// a flat vertical list (no tree branching). The group is a neutral meta-group:
// its header carries a triangle-at-start collapse toggle, a left-edge hue dot
// legend (always visible), and the categorized summary. The header
// summarizes tool actions only — thinking actions are invisible until the
// group is expanded. Group collapse state:
// expandedActionGroups keyed by the first action's "${entryId}:${blockIndex}".
// Effective expanded state (ADR 07):
//   expanded.has(key) || (isStreaming && isTrailing && !frozen.has(key))
//
// A single-action group renders the same header as a multi-action group — one
// dot, the action's own summary — so a lone action rests in the same collapsed
// dot-row state as a collapsed group. Opening it auto-expands the lone action's
// details (store-side) so the tinted row shows without a second click.

import { memo, useCallback, useMemo } from "react";
import {
	type ActionHue,
	type ActionKind,
	type ActionVM,
	actionPulls,
	type InlineGitStamp,
	kindForTool,
	kindHue,
	type ToolActionVM,
} from "../../../../src/viewmodel/index.ts";
import { enqueuePulls } from "../../infra/net/pullQueue.ts";
import { useStore } from "../../infra/state/store.tsx";
import styles from "./actions.module.css";
import type { ActionSummaryItem } from "./formatGroupSummary.ts";
import { formatGroupSummary } from "./formatGroupSummary.ts";
import { GitChangeCard } from "./GitChangeCard.tsx";
import { ThinkActionView } from "./ThinkActionView.tsx";
import { ToolActionView } from "./ToolActionView.tsx";

/** Dot entries for the left-edge dot legend: tool hues (in stable
 * precedence order, matching formatGroupSummary's category order) plus the
 * meta "git" entry first when the group holds mid-turn inline git stamps. Thinking
 * actions are excluded — the header surfaces tool actions only. */
function groupDots(actions: ActionVM[], gitChanges: InlineGitStamp[] | undefined): (ActionHue | "git")[] {
	const seen = new Set<ActionHue>();
	for (const s of actions) {
		if (s.blockType === "thinking") continue;
		const kind: ActionKind = kindForTool((s as ToolActionVM).toolName);
		seen.add(kindHue(kind));
	}
	// Stable display order: git (meta, first — highest precedence, matching
	// the summary), then mutate, bash, read (the tool label precedence
	// edit > write > bash > read, collapsed via hue).
	const order: ActionHue[] = ["mutate", "bash", "read"];
	const hues = order.filter((f) => seen.has(f));
	return (gitChanges?.length ?? 0) > 0 ? ["git", ...hues] : hues;
}

export const ActionGroupView = memo(function ActionGroupView({
	groupKey,
	actions,
	gitChanges,
	isTrailing,
	onToggleGroup,
	onToggleAction,
}: {
	groupKey: string;
	actions: ActionVM[];
	/** ADR 10 v2: mid-turn inline git stamps assigned to this group — the summary
	 * gains a "git:" segment and each renders as its own card in the group's vertical line
	 * after the action it follows. */
	gitChanges?: InlineGitStamp[];
	isTrailing: boolean;
	onToggleGroup: (key: string, cardKeys: string[]) => void;
	onToggleAction: (key: string) => void;
}) {
	const isExpanded = useStore(useCallback((s) => s.expandedActionGroups.has(groupKey), [groupKey]));
	const isFrozen = useStore(useCallback((s) => s.frozenActionGroups.has(groupKey), [groupKey]));

	// ADR 09: the collapsed header names only edit/write files — bash and
	// read render as counts, which need no arguments — so only those kinds
	// pull `arguments` at group level. Action views register their own
	// arguments pulls when rendered (ToolActionView), so expanded rows
	// keep their live summaries.
	// The pullTick subscription re-registers pulls after pull failures and
	// refreshes summaries after ingests.
	useStore((s) => s.pullTick);
	enqueuePulls(
		actions.flatMap((s) => {
			if (s.blockType !== "tool") return [];
			const kind = kindForTool((s as ToolActionVM).toolName);
			return kind === "edit" || kind === "write" ? actionPulls(s, false) : [];
		}),
	);

	// During streaming, the trailing group auto-expands — actions appear,
	// details stay collapsed — unless the user froze it by toggling manually.
	const effectiveExpanded = isExpanded || (isTrailing && !isFrozen);

	// Compute the label from live store data so it updates as tool call
	// arguments stream in (the VM cache key does not include argument values).
	// Only the path basename is extracted — edit/write are the sole named
	// categories; every other tool is counted by name alone.
	const label = useStore(
		useCallback(
			(s) => {
				const entries = s.document.entries;
				const items: ActionSummaryItem[] = actions.map((h) => {
					if (h.blockType === "thinking") {
						return { toolName: "thinking", basename: null };
					}
					const entry = entries[h.entryId];
					const block = entry?.kind === "message" ? entry.content[h.blockIndex] : null;
					const liveArgs = block?.type === "toolCall" ? block.arguments : (h as ToolActionVM).arguments;
					const recArgs =
						liveArgs !== null && typeof liveArgs === "object" ? (liveArgs as Record<string, unknown>) : null;
					const rawPath = recArgs ? ((recArgs.path as string) ?? (recArgs.filePath as string) ?? null) : null;
					return {
						toolName: (h as ToolActionVM).toolName,
						basename: rawPath ? rawPath.split("/").pop() || rawPath : null,
					};
				});
				return formatGroupSummary(
					items,
					gitChanges?.map((c) => c.identity),
				);
			},
			[actions, gitChanges],
		),
	);

	const hues = useMemo(() => groupDots(actions, gitChanges), [actions, gitChanges]);

	return (
		<div className={styles.actionGroup}>
			<button
				type="button"
				className={styles.actionGroupHeader}
				onClick={() =>
					onToggleGroup(
						groupKey,
						actions.map((h) => `${h.entryId}:b${h.blockIndex}`),
					)
				}
				aria-expanded={effectiveExpanded}
				aria-label={`${effectiveExpanded ? "Collapse" : "Expand"} action group: ${label}`}
			>
				<span className={styles.collapseTri}>{effectiveExpanded ? "\u25BE" : "\u25B8"}</span>
				{/* Left-edge hue legend — always visible (stable landmark;
				    the tinted rows below are the expanded detail, the dots are the
				    summary). One dot per hue, same --kind-* tokens as
				    the row strips/tints. Git leads when present (highest
				    precedence, matching the summary's category order). */}
				{hues.length > 0 && (
					<span className={styles.groupDots}>
						{hues.map((f) => (
							<span key={f} data-hue={f} />
						))}
					</span>
				)}
				<span className={styles.actionGroupSummary}>{label}</span>
			</button>
			{effectiveExpanded && (
				<div className={styles.groupLine}>
					{actions.map((h) => (
						<div key={`${h.entryId}:${h.blockIndex}`}>
							{h.blockType === "thinking" ? (
								<ThinkActionView action={h} onToggleAction={onToggleAction} />
							) : (
								<ToolActionView action={h} onToggleAction={onToggleAction} />
							)}
							{/* ADR 10 v2: the git card renders after the action it follows. */}
							{gitChanges
								?.filter((c) => c.afterBlockKey === `${h.entryId}:b${h.blockIndex}`)
								.map((c) => (
									<GitChangeCard key={c.entryId} change={c} />
								))}
						</div>
					))}
					{/* Inline git stamps whose anchor block is not an action of this group (e.g. a
					    trailing turn_end stamp after a closing text block, assigned here
					    as the turn's last group) render after the last action. */}
					{gitChanges
						?.filter((c) => !actions.some((h) => c.afterBlockKey === `${h.entryId}:b${h.blockIndex}`))
						.map((c) => (
							<GitChangeCard key={c.entryId} change={c} />
						))}
				</div>
			)}
		</div>
	);
});
