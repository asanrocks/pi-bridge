// ============================================================================
// RecoveryBar — the broken-tail recovery actions (ADR 16), presentational.
// Recoveries are always carried by an error row on the dead turn (ADR 16):
// the row's line is the turn's real error/abort text, or a synthetic one
// (`recoveryNotice`) when pi persisted no error — silent interruption. The
// buttons dock beside that line; the caller gates them (idle, connected,
// live leaf, not editing — the send gates) and the line renders regardless.
// The labels predict the mechanism before the click:
//   Retry            — silently re-request from a clean boundary: no
//                      interrupted work is re-run or re-sent, nothing is
//                      added to the transcript. Offered with Edit.
//   Send "Continue." — the one action that adds a message: a visible
//                      "Continue." user turn, with a bounded recovery record
//                      when the dangling assistant's child results are removed.
//   Edit             — fork at the user message and resend (the composer's
//                      edit mode). Unambiguous; rides along with Retry.
// ============================================================================

import type { RecoverableTurnKind } from "../../../../src/core/index.ts";
import styles from "./turns.module.css";

/** Why Retry is safe, per failure mode — the tooltip picks the one that
 * matches the tail (an error turn is branched away; an aborted turn with
 * tool work keeps its results; a text-only stop produced nothing; an
 * unfinished run continues from its completed results). */
export function retryTitle(kind: RecoverableTurnKind, stopReason: string | undefined, hasToolWork: boolean): string {
	if (kind === "unfinishedTurn") {
		return "Finish the reply from the completed tool results — nothing new is added";
	}
	if (stopReason === "error") {
		return "Request a new reply — nothing is added to the transcript; the failed attempt stays in history as a fork.";
	}
	if (hasToolWork) {
		return "Regenerate the reply from the completed tool results — no tools re-run.";
	}
	return "Answer again from your message — the stopped attempt produced nothing.";
}

/** The synthetic failure line for tails pi never persisted an error for
 * (process death mid-run — silent data loss). `failedTurn` never needs one:
 * its dead turn carries a real error or abort line. */
export function recoveryNotice(kind: RecoverableTurnKind): string {
	switch (kind) {
		case "interruptedTools":
			return "Interrupted while running tools — some calls have no recorded result";
		case "unfinishedTurn":
			return "Interrupted before the reply finished";
		case "failedTurn":
			return "Stopped";
	}
}

export interface RecoveryActionsProps {
	kind: RecoverableTurnKind;
	/** The dead turn's own stop reason, for the Retry tooltip. */
	stopReason?: string;
	/** Whether the dead turn ran tools, for the Retry tooltip. */
	hasToolWork: boolean;
	/** The recoverTurn RPC — Retry for the silent family, the Continue
	 * relay for terminated tool work. */
	onRecover: () => void;
	/** Edit the run's user message and resend. Omitted when the path has no
	 * user message to edit (then only the silent action renders). */
	onEdit?: () => void;
}

export function RecoveryActions({ kind, stopReason, hasToolWork, onRecover, onEdit }: RecoveryActionsProps) {
	if (kind === "interruptedTools") {
		// The simulated turn: the label is the mechanism — the user sees
		// exactly what will appear in the transcript before clicking.
		return (
			<span className={styles.recoveryActions}>
				<button
					type="button"
					className={styles.recoveryBtn}
					onClick={onRecover}
					title="Sends 'Continue.' with completed tool results and calls whose outcomes are unknown"
				>
					{`Send "Continue."`}
				</button>
			</span>
		);
	}
	return (
		<span className={styles.recoveryActions}>
			<button
				type="button"
				className={styles.recoveryBtn}
				onClick={onRecover}
				title={retryTitle(kind, stopReason, hasToolWork)}
			>
				Retry
			</button>
			{onEdit !== undefined && (
				<button
					type="button"
					className={styles.recoveryBtn}
					onClick={onEdit}
					title="Edit your message and resend from there"
				>
					Edit
				</button>
			)}
		</span>
	);
}
