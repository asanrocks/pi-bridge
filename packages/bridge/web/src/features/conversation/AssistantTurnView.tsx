// AssistantTurnView — flat (unbubbled) turn whose first line is the shared
// compact header (ADR 21): date disclosure, context reading, and the action
// menu. The model in force and the completed durations are statistics now and
// live behind the date; while the turn streams, its live status takes the same
// trailing slot, so progress never hides behind a disclosure and never costs a
// second line. Copy lives per message (TextBlockView), not here: a merged turn
// holds several messages, so there is no single "turn text" to copy.
// Consecutive actions are segmented into action groups (renderer-owned
// grouping) sharing a vertical line. Padding matches the user tinted row so
// headers/text align.

import { memo, useCallback, useMemo, useRef } from "react";
import {
	type AssistantTurn,
	assignGroupGitChanges,
	type GroupGitChanges,
	type ParsedProviderError,
	segmentBlocks,
	type TurnRecovery,
	type TurnSegment,
} from "../../../../src/viewmodel/index.ts";
import { useStore } from "../../infra/state/store.tsx";
import { displayModelName, displayProviderName } from "../../render/modelNames.ts";
import { ActionGroupView } from "./ActionGroupView.tsx";
import { formatLiveStatus } from "./format.ts";
import { GitChangeView } from "./GitChangeView.tsx";
import type { HeaderDensity } from "./headerDensity.ts";
import { RecoveryActions, recoveryNotice } from "./RecoveryBar.tsx";
import { TextBlockView } from "./TextBlockView.tsx";
import { TurnHeader } from "./TurnHeader.tsx";
import { assistantTurnDetails } from "./turnDetails.ts";
import styles from "./turns.module.css";
import { useTurnClock } from "./useTurnClock.ts";

export const AssistantTurnView = memo(function AssistantTurnView({
	turn,
	isStreaming,
	onToggleGroup,
	onToggleAction,
	recovery,
	density,
}: {
	turn: AssistantTurn;
	isStreaming: boolean;
	onToggleGroup: (key: string, cardKeys: string[]) => void;
	onToggleAction: (key: string) => void;
	/** The measured conversation column's header tier (ADR 21). */
	density: HeaderDensity;
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

	// Grouping and stamp assignment are renderer-owned but carry their previous
	// result forward: unchanged segments/groups keep their identity, so only the
	// groups a delta actually touched re-render. Without the carry, a new
	// segments array per delta would defeat every group's memo (see
	// segmentBlocks).
	const segmentsRef = useRef<TurnSegment[] | null>(null);
	const segments = useMemo(() => segmentBlocks(turn.blocks, segmentsRef.current ?? undefined), [turn.blocks]);
	segmentsRef.current = segments;
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
	const groupGitRef = useRef<GroupGitChanges | null>(null);
	const groupGit = useMemo(
		() => assignGroupGitChanges(segments, turn.gitChanges ?? [], groupGitRef.current ?? undefined),
		[segments, turn.gitChanges],
	);
	groupGitRef.current = groupGit;
	const lastIdx = segments.length - 1;
	const models = useStore(useCallback((s) => s.models, []));
	const modelName = turn.model ? displayModelName(turn.provider ?? "", turn.model, models) : "";
	const providerName = turn.provider ? displayProviderName(turn.provider, models) : "";

	// The instant the header names. A streaming turn's own entry has no seal, so
	// `timestamp` is empty until its first message lands — the header would name
	// no moment at all for the first seconds of every reply. The turn's start
	// anchor (the seal of the entry that opened it, usually the prompt) is that
	// moment, and it is the same reading the live span measures from; once the
	// entry seals, the turn's own instant takes over. Both read as "just now".
	const displayInstant = turn.timestamp || turn.turnStartedAt || "";

	// Live status while the turn streams — the only progress signal that does
	// not wait for a content delta. The clock ticks once a second only for the
	// streaming turn (useTurnClock is inert when `active` is false).
	const liveNow = useTurnClock(isStreaming);
	const runningTools = turn.blocks.filter(
		(b) => b.blockType === "tool" && (b.status === "pending" || b.status === "running"),
	).length;
	const liveStatus = isStreaming
		? formatLiveStatus({ turnStartedAt: turn.turnStartedAt, runningTools, now: liveNow })
		: "";

	// The ledger's three sections: the turn's producer, the window reading, and the
	// timing. The row rules live in turnDetails (a label on every value, `~` for
	// estimates, absent data absent) so they can be tested as data.
	const details = useMemo(
		() =>
			assistantTurnDetails({
				timestamp: turn.timestamp,
				turnStartedAt: turn.turnStartedAt,
				modelName,
				providerName,
				totalMs: turn.totalMs,
				toolMs: turn.toolMs,
				contextPercent: turn.contextPercent,
				contextDeltaPercent: turn.contextDeltaPercent,
			}),
		[
			turn.timestamp,
			turn.turnStartedAt,
			modelName,
			providerName,
			turn.totalMs,
			turn.toolMs,
			turn.contextPercent,
			turn.contextDeltaPercent,
		],
	);

	// The header's trailing reading, one slot with two tenants. While the turn
	// streams it carries the live status (the span plus the running-tool count),
	// which is the only progress signal that does not wait for a content delta;
	// once the turn seals it carries the context reading, because that percentage
	// only exists with the last entry's usage. The two never compete, so the
	// status costs no second line — and the slot swaps in place at the seal
	// instead of the header losing a row.
	//
	// The percentage stands alone: the composer already renders the context as a
	// bare `21%` with a bar, so a `context` descriptor here was the odd one out and
	// cost the header the width a label needs. Its meaning and its change are one
	// gesture away on the date's disclosure; the tooltip is a hint for the pointer,
	// never the only route to the numbers.
	let reading: { text: string; title: string } | undefined;
	if (liveStatus) {
		reading = { text: liveStatus, title: "This turn is still running" };
	} else if (turn.contextPercent !== undefined) {
		const pct = Math.round(turn.contextPercent);
		reading = {
			text: `${pct}%`,
			title: `Context window: ${pct}% used when this turn was generated`,
		};
	}

	return (
		<article
			className={`${styles.asstMsg} ${isDimmed ? styles.msgDimmed : ""} ${isFocused ? styles.focused : ""}`}
			// Unique per-turn anchor: a split entry yields two turns sharing the
			// first entry's id, so focus/keyboard scroll targets key on turnKey.
			data-turn-key={turn.turnKey}
			// data-entry-id only on the turn that starts at block 0 of its
			// entry (turnKey === entryId): the history-pane anchor
			// (scrollToEntryId → querySelector, first match) must resolve to
			// the entry's first turn — the message.
			data-entry-id={turn.turnKey === turn.entryId ? turn.entryId : undefined}
			// A message is a self-contained composition, and the visible model label
			// is gone: the name is what keeps the role distinction available to
			// assistive tech.
			aria-label="Assistant message"
		>
			<TurnHeader
				timestamp={displayInstant}
				density={density}
				details={details}
				reading={reading}
				// An assistant turn has no header command of its own: Copy is per
				// message and the statistics are the date's, so the menu has nothing
				// to own and does not render a trigger.
				menuItems={[]}
				menuLabel="Turn actions"
			/>
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
		</article>
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
