// AssistantTurnView — flat (unbubbled) turn whose first line is the turn
// header (provider/model · timestamp, left). Copy lives per message
// (TextBlockView), not here: a merged turn holds several messages, so
// there is no single "turn text" to copy. Consecutive actions are segmented
// into action groups (renderer-owned grouping) sharing a vertical line.
// Padding matches the user tinted row so headers/text align.

import { memo, useCallback, useMemo } from "react";
import {
	type AssistantTurn,
	assignGroupGitChanges,
	type ParsedProviderError,
	segmentBlocks,
	type TurnRecovery,
} from "../../../../src/viewmodel/index.ts";
import { formatTimestamp } from "../../infra/lib/time.ts";
import { useStore } from "../../infra/state/store.tsx";
import { displayModelLabel } from "../../render/modelNames.ts";
import { ActionGroupView } from "./ActionGroupView.tsx";
import { GitChangeView } from "./GitChangeView.tsx";
import { RecoveryActions, recoveryNotice } from "./RecoveryBar.tsx";
import { TextBlockView } from "./TextBlockView.tsx";
import styles from "./turns.module.css";

export const AssistantTurnView = memo(function AssistantTurnView({
	turn,
	isStreaming,
	onToggleGroup,
	onToggleAction,
	recovery,
}: {
	turn: AssistantTurn;
	isStreaming: boolean;
	onToggleGroup: (key: string, cardKeys: string[]) => void;
	onToggleAction: (key: string) => void;
	/** Broken-tail recovery (ADR 16), present only on the dead turn. The
	 * error row below is the recovery carrier: the turn's real error/abort
	 * line, or a synthetic one (`recoveryNotice`) when pi persisted no
	 * error — silent interruption. `armed` gates only the buttons (idle,
	 * connected, live leaf, not editing — the send gates); the line renders
	 * regardless. */
	recovery?: {
		kind: TurnRecovery["kind"];
		armed: boolean;
		onRecover: () => void;
		onEdit?: () => void;
	};
}) {
	const isDimmed = useStore(useCallback((s) => s.draft.kind === "edit" && turn.index >= s.draft.index, [turn.index]));
	const isFocused = useStore(useCallback((s) => s.focusedTurnId === turn.turnKey, [turn.turnKey]));

	const segments = useMemo(() => segmentBlocks(turn.blocks), [turn.blocks]);
	// The recovery buttons dock beside the error row's line — the one
	// recovery surface (ADR 16). Computed once for whichever branch below
	// renders the row.
	const recoveryActions = recovery?.armed ? (
		<RecoveryActions
			kind={recovery.kind}
			stopReason={turn.stopReason}
			hasToolWork={turn.blocks.some((b) => b.blockType === "tool")}
			onRecover={recovery.onRecover}
			onEdit={recovery.onEdit}
		/>
	) : undefined;
	// ADR 10 v2: mid-turn inline git stamps fold into the groups they render in —
	// summary segment + in-group card. Inline git stamps with no group (a text-only turn)
	// fall back to standalone cards after the segments.
	const groupGit = useMemo(() => assignGroupGitChanges(segments, turn.gitChanges ?? []), [segments, turn.gitChanges]);
	const lastIdx = segments.length - 1;
	const ts = formatTimestamp(turn.timestamp);
	const models = useStore(useCallback((s) => s.models, []));
	const modelLabel = turn.model ? displayModelLabel(turn.provider ?? "", turn.model, models) : "";

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
						actions={seg.actions}
						gitChanges={groupGit.byGroup.get(seg.key)}
						isTrailing={isStreaming && idx === lastIdx}
						onToggleGroup={onToggleGroup}
						onToggleAction={onToggleAction}
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
			{/* Abnormal stop reasons (error, aborted, length) render below the
			    content. ADR 16: the error row is the recovery carrier — the dead
			    turn's real error/abort line with the buttons beside it, or a
			    synthetic line for the silent interruption shapes (no error entry
			    was ever persisted). */}
			{turn.stopReason === "error" && (
				<div className={styles.errorRow}>
					<ProviderErrorLine parsedError={turn.parsedError} errorMessage={turn.errorMessage} />
					{recoveryActions}
				</div>
			)}
			{turn.stopReason === "aborted" && (
				<div className={styles.errorRow}>
					<div className={styles.errorLine}>{turn.errorMessage || "Operation aborted"}</div>
					{recoveryActions}
				</div>
			)}
			{turn.stopReason === "length" && (
				<div className={styles.errorLine}>
					Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.
				</div>
			)}
			{recovery && turn.stopReason !== "error" && turn.stopReason !== "aborted" && (
				<div className={styles.errorRow}>
					<div className={styles.errorLine}>{recoveryNotice(recovery.kind)}</div>
					{recoveryActions}
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
