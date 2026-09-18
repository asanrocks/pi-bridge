// AssistantTurnView — flat (unbubbled) turn whose first line is the turn
// header (provider/model · timestamp, left). Copy lives per message
// (TextBlockView), not here: a run-merged turn holds several messages, so
// there is no single "turn text" to copy. Consecutive steps are segmented
// into action groups (renderer-owned grouping) sharing a visual spine.
// Padding matches the user band so headers/text align.

import { memo, useCallback, useMemo } from "react";
import {
	type AssistantTurn,
	assignGroupGitChanges,
	type ParsedProviderError,
	segmentBlocks,
} from "../../../../src/viewmodel/index.ts";
import { useStore } from "../../infra/state/store.tsx";
import { displayModelLabel } from "../../render/modelNames.ts";
import { ActionGroupView } from "./ActionGroupView.tsx";
import { formatDuration, formatTimestamp } from "./format.ts";
import { GitChangeView } from "./GitChangeView.tsx";
import { TextBlockView } from "./TextBlockView.tsx";
import styles from "./turns.module.css";
import { useNow } from "./useNow.ts";

export const AssistantTurnView = memo(function AssistantTurnView({
	turn,
	isStreaming,
	onToggleGroup,
	onToggleStep,
}: {
	turn: AssistantTurn;
	isStreaming: boolean;
	onToggleGroup: (key: string, cardKeys: string[]) => void;
	onToggleStep: (key: string) => void;
}) {
	const isDimmed = useStore(useCallback((s) => s.draft.kind === "edit" && turn.index >= s.draft.index, [turn.index]));
	const isFocused = useStore(useCallback((s) => s.focusedTurnId === turn.turnKey, [turn.turnKey]));

	// Live ticking total for the in-flight turn. The viewmodel resolves the
	// authoritative server-based totalMs/toolMs only at seal (provisional
	// entries carry no timestamp); while streaming, the renderer shows a
	// Date.now()-anchored delta that swaps to the server value on seal.
	const now = useNow(isStreaming);

	const segments = useMemo(() => segmentBlocks(turn.blocks), [turn.blocks]);
	// ADR 10 v2: mid-run git marks fold into the groups they render in —
	// summary segment + in-group card. Marks with no group (a text-only run)
	// fall back to standalone cards after the segments.
	const groupGit = useMemo(() => assignGroupGitChanges(segments, turn.gitChanges ?? []), [segments, turn.gitChanges]);
	const lastIdx = segments.length - 1;
	const ts = formatTimestamp(turn.timestamp);
	const models = useStore(useCallback((s) => s.models, []));
	const modelLabel = turn.model ? displayModelLabel(turn.provider ?? "", turn.model, models) : "";

	// Timing fragment: sealed turns show total/tool split (post-hoc); the live
	// turn shows a ticking total plus a running-tool count (the only in-flight
	// signal available — tool durations need seals that don't exist yet).
	let timing: string;
	if (isStreaming && turn.turnStartedAt) {
		const startMs = new Date(turn.turnStartedAt).getTime();
		const live = formatDuration(Number.isNaN(startMs) ? undefined : now - startMs);
		const running = turn.blocks.filter(
			(b) => b.blockType === "tool" && (b.status === "pending" || b.status === "running"),
		).length;
		timing = live ? (running > 0 ? `${live} · ${running} running` : live) : "";
	} else if (turn.totalMs !== undefined) {
		const tot = formatDuration(turn.totalMs);
		const tools = turn.toolMs !== undefined && turn.toolMs >= 1000 ? formatDuration(turn.toolMs) : "";
		timing = tools ? `${tot} · tools ${tools}` : tot;
	} else {
		timing = "";
	}

	// Context occupancy for this turn: "26%" absolute, "(+1%)" the change
	// vs. the previous valid reading (omitted below the 1pp threshold;
	// negative — the compaction drop — always renders). Rounded to whole
	// points: this is a compact/expand decision aid, not a billing figure.
	let contextFrag = "";
	if (turn.contextPercent !== undefined) {
		const pct = Math.round(turn.contextPercent);
		const delta = turn.contextDeltaPercent === undefined ? null : Math.round(turn.contextDeltaPercent);
		const deltaFrag = delta === null ? "" : ` (${delta >= 0 ? "+" : ""}${delta}%)`;
		contextFrag = `${pct}%${deltaFrag}`;
	}

	return (
		<div
			className={`${styles.asstMsg} ${isDimmed ? styles.msgDimmed : ""} ${isFocused ? styles.focused : ""}`}
			// Unique per-turn anchor: a split entry yields two turns sharing the
			// first entry's id, so focus/keyboard scroll targets key on turnKey.
			data-turn-key={turn.turnKey}
			// data-entry-id only on the turn that starts at block 0 of its
			// entry (turnKey === entryId): the history-pane anchor
			// (scrollToEntryId → querySelector, first match) must resolve to
			// the entry's first turn — the message.
			data-entry-id={turn.turnKey === turn.entryId ? turn.entryId : undefined}
		>
			<div className={styles.msgHeader}>
				<span className={styles.msgHeaderLeft}>
					{ts && <span className={styles.msgTime}>{ts}</span>}
					{modelLabel && <span className={styles.msgRole}>{modelLabel}</span>}
					{timing && <span className={styles.msgTiming}>{timing}</span>}
					{contextFrag && <span className={styles.msgTiming}>{contextFrag}</span>}
				</span>
			</div>
			{segments.map((seg, idx) =>
				seg.kind === "text" ? (
					<TextBlockView
						key={`${seg.block.entryId}:${seg.block.blockIndex}`}
						entryId={seg.block.entryId}
						blockIndex={seg.block.blockIndex}
						isProvisional={seg.block.isProvisional}
						showCursor={isStreaming && idx === lastIdx}
					/>
				) : (
					<ActionGroupView
						key={seg.key}
						groupKey={seg.key}
						steps={seg.steps}
						gitChanges={groupGit.byGroup.get(seg.key)}
						isTrailing={isStreaming && idx === lastIdx}
						onToggleGroup={onToggleGroup}
						onToggleStep={onToggleStep}
					/>
				),
			)}
			{groupGit.unattached.map((c) => (
				<GitChangeView
					key={c.entryId}
					turn={{
						kind: "gitChange",
						entryId: c.entryId,
						index: turn.index,
						timestamp: c.timestamp,
						identity: c.identity,
						commitSubject: c.commitSubject,
						anchor: c.anchor,
						isInitial: c.isInitial,
					}}
				/>
			))}
			{/* Abnormal stop reasons (error, aborted, length) render below the content. */}
			{turn.stopReason === "error" && (
				<ProviderErrorLine parsedError={turn.parsedError} errorMessage={turn.errorMessage} />
			)}
			{turn.stopReason === "aborted" && (
				<div className={styles.errorLine}>{turn.errorMessage || "Operation aborted"}</div>
			)}
			{turn.stopReason === "length" && (
				<div className={styles.errorLine}>
					Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.
				</div>
			)}
		</div>
	);
});

/**
 * Error line with a first-class status/message plus a muted KV dump for the
 * remaining parsed fields (code, param, type, ...). Falls back to the raw
 * string when the error did not parse into the `"<status>: {json}"` shape.
 */
function ProviderErrorLine({
	parsedError,
	errorMessage,
}: {
	parsedError?: ParsedProviderError;
	errorMessage?: string;
}) {
	if (!parsedError) {
		return errorMessage ? <div className={styles.errorLine}>{errorMessage}</div> : null;
	}
	const primary =
		parsedError.status !== undefined ? `Error ${parsedError.status}: ${parsedError.message}` : parsedError.message;
	const attrs = Object.entries(parsedError.attrs);
	return (
		<>
			<div className={styles.errorLine}>{primary}</div>
			{attrs.length > 0 && (
				<div className={styles.errorAttrs}>
					{attrs.map(([key, value]) => (
						<div key={key} className={styles.errorAttr}>
							<span className={styles.errorAttrKey}>{key}:</span> {value}
						</div>
					))}
				</div>
			)}
		</>
	);
}
