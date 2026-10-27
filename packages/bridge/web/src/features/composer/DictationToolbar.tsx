// ============================================================================
// DictationToolbar — the composer's text panel, and the only place its text
// operations change state. The microphone discloses it; this row records,
// keeps, discards, polishes, and takes one edit back.
//
// The row is phase-driven so the controls always match what can actually
// happen:
//
//   idle / failed   Dictation                  [undo?] [polish?] [record ●]
//   unavailable     Dictation needs a connection …   [undo?] [polish?]
//   preparing       ● Starting the microphone          [discard]
//   listening       ● Listening 0:07  [meter]          [keep] [discard]
//   committing      ● Finishing
//   polishing       ● Polishing                        [discard]
//   polish failed   <the reason>          [undo?] [polish?] [record ●]
//   no change       Nothing to polish …   [undo?] [polish?] [record ●]
//
// The endings disappear with `committing`: the stop already happened and the
// terminal transcript is inbound. Keep appears only once there is audio to keep.
// Polish is offered only in the idle form: it rewrites the whole draft, and the
// field is locked while it runs (see useDictation), so it cannot be a control of
// the live row.
//
// It is also where the capability answer lives. A microphone that cannot start
// states its reason here rather than in a notice toast, so dictation has one
// surface and nothing interrupts the composer; and the last committed
// transcript or installed polish can be taken back from the idle row, which is
// the only Undo the feature needs. One slot, one control: it always means "take
// back the last thing this composer did to the text", so there is nothing to
// choose between on a phone that has no Ctrl+Z.
//
// Icons only: several controls side by side have to be told apart at a glance
// and worded buttons would crowd the field on a phone, so the words live in
// `aria-label`/`title`. None of them is a microphone — that glyph is the
// composer's disclosure for this panel, and one glyph cannot mean both "show the
// controls" and "record".
//
// The ~50 Hz level never enters React state: it is written straight to
// `--asr-level` on this element, and the clock is a 1 Hz text write, so a
// running utterance does not re-render the composer it is typing into.
// ============================================================================

import type { Dictation, DictationPhase } from "@earendil-works/pi-asr/dictation";
import { memo, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { CheckIcon, CloseIcon, PolishIcon, RecordIcon, UndoIcon } from "../../render/icons.tsx";
import styles from "./ComposeCard.module.css";
import { DICTATION_TOOLBAR_ID } from "./DictationToggle.tsx";
import type { PolishState } from "./textPolish.ts";

/** Stable idle snapshot for the no-controller case: `useSyncExternalStore`
 * compares by reference, so a fresh `{ kind: "idle" }` per render would loop. */
const IDLE_PHASE: DictationPhase = { kind: "idle" };

const LABELS: Record<DictationPhase["kind"], string> = {
	idle: "Dictation",
	preparing: "Starting the microphone",
	listening: "Listening",
	committing: "Finishing",
	failed: "Dictation",
};

/** What the undo control would take back. Both operations share one slot, so the
 * words have to name the operation, not the mechanism. */
const UNDO_LABELS: Record<"dictation" | "polish", { label: string; title: string }> = {
	dictation: { label: "Remove the inserted transcript", title: "Remove the inserted transcript" },
	polish: { label: "Undo the polish", title: "Undo the polish" },
};

/** Polish has two answers worth a sentence: it could not run, or it had nothing
 * to change (the service's own verdict on text that already reads well). */
function polishNotice(state: PolishState): string | null {
	switch (state.kind) {
		case "failed":
			return state.reason;
		case "unchanged":
			return "Nothing to polish. The text already reads well.";
		default:
			return null;
	}
}

/** See DictationToggle: pressing a control must not take focus from the field. */
const keepFocus = (event: React.PointerEvent): void => event.preventDefault();

export const DictationToolbar = memo(function DictationToolbar({
	dictation,
	reason,
	undoKind,
	polish,
	canPolish,
	onRecord,
	onKeep,
	onDiscard,
	onUndo,
	onPolish,
	onCancelPolish,
}: {
	/** The controller, or null while there is no credential. Polish needs none:
	 * the panel is the composer's text surface, not a microphone panel, so it
	 * renders with its idle row even when dictation cannot start. */
	dictation: Dictation | null;
	/** Why the microphone cannot start, or null when it can. Stated in place —
	 * the toolbar is also where dictation explains itself. */
	reason: string | null;
	/** What the undo control takes back, or null when there is nothing to. */
	undoKind: "dictation" | "polish" | null;
	/** The last polish attempt, for the idle row. */
	polish: PolishState;
	/** The daemon may rewrite drafts, so the polish control is offered. */
	canPolish: boolean;
	/** Start an utterance (or continue after a keep). */
	onRecord: () => void;
	/** Finish now, keeping the transcript. */
	onKeep: () => void;
	/** Drop the utterance. */
	onDiscard: () => void;
	/** Take back the last transcript or polish. */
	onUndo: () => void;
	/** Rewrite the whole draft. */
	onPolish: () => void;
	/** Stop waiting for the polish answer. */
	onCancelPolish: () => void;
}) {
	const phase = useSyncExternalStore(
		useCallback((notify: () => void) => dictation?.subscribe(notify) ?? noop, [dictation]),
		useCallback(() => dictation?.phase ?? IDLE_PHASE, [dictation]),
	);
	const rootRef = useRef<HTMLDivElement>(null);
	const clockRef = useRef<HTMLSpanElement>(null);
	const listening = phase.kind === "listening";
	/** An utterance is in flight (or settling): the row is a status, not a menu. */
	const live = phase.kind === "preparing" || listening || phase.kind === "committing";
	const polishing = polish.kind === "running";
	const notice = polishNotice(polish);
	const undo = undoKind === null ? null : UNDO_LABELS[undoKind];

	useEffect(() => {
		if (dictation === null) return;
		return dictation.onLevel((reading) => {
			rootRef.current?.style.setProperty("--asr-level", reading.level.toFixed(3));
		});
	}, [dictation]);

	useEffect(() => {
		if (!listening) return;
		const startedAt = performance.now();
		const write = (): void => {
			const element = clockRef.current;
			if (element === null) return;
			const seconds = Math.floor((performance.now() - startedAt) / 1000);
			element.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
		};
		write();
		const timer = setInterval(write, 1000);
		return () => clearInterval(timer);
	}, [listening]);

	return (
		<div
			id={DICTATION_TOOLBAR_ID}
			className={styles.dictationToolbar}
			data-phase={live ? phase.kind : polishing ? "polishing" : "idle"}
			ref={rootRef}
		>
			{live || polishing ? (
				<>
					<span className={styles.dictationDot} aria-hidden="true" />
					{/* `<output>` is the implicit role="status" element, so a phase change
					    is announced once; the clock beside it is not, or it would speak
					    every second. */}
					<output className={styles.dictationLabel}>{live ? LABELS[phase.kind] : "Polishing"}</output>
					{listening && (
						<span className={styles.dictationClock} ref={clockRef} aria-hidden="true">
							0:00
						</span>
					)}
					{live && (
						<span className={styles.dictationMeter} aria-hidden="true">
							<span className={styles.dictationMeterFill} />
						</span>
					)}
					<span className={styles.dictationActions}>
						{listening && (
							<button
								type="button"
								className={styles.dictationAction}
								data-action="keep"
								onPointerDown={keepFocus}
								onClick={onKeep}
								aria-label="Stop dictation and insert the transcript"
								title="Stop and insert the transcript"
							>
								<CheckIcon />
							</button>
						)}
						{live && phase.kind !== "committing" && (
							<button
								type="button"
								className={styles.dictationAction}
								data-action="discard"
								onPointerDown={keepFocus}
								onClick={onDiscard}
								aria-label="Discard this dictation"
								title="Discard this dictation"
							>
								<CloseIcon />
							</button>
						)}
						{polishing && (
							<button
								type="button"
								className={styles.dictationAction}
								data-action="discard"
								onPointerDown={keepFocus}
								onClick={onCancelPolish}
								aria-label="Stop waiting for the polish"
								title="Stop waiting for the polish"
							>
								<CloseIcon />
							</button>
						)}
					</span>
				</>
			) : (
				<>
					{notice !== null ? (
						<output className={styles.dictationReason}>{notice}</output>
					) : reason === null ? (
						<span className={styles.dictationLabel}>{LABELS[phase.kind]}</span>
					) : (
						<output className={styles.dictationReason}>{reason}</output>
					)}
					<span className={styles.dictationActions}>
						{/* Offered only while the edit is still in the field: an Undo that
						    cannot act is worse than no Undo. */}
						{undo !== null && (
							<button
								type="button"
								className={styles.dictationAction}
								data-action="undo"
								onPointerDown={keepFocus}
								onClick={onUndo}
								aria-label={undo.label}
								title={undo.title}
							>
								<UndoIcon />
							</button>
						)}
						{canPolish && (
							<button
								type="button"
								className={styles.dictationAction}
								data-action="polish"
								onPointerDown={keepFocus}
								onClick={onPolish}
								aria-label="Polish the draft"
								title="Polish the draft (the text is sent to the IME service)"
							>
								<PolishIcon />
							</button>
						)}
						{reason === null && (
							<button
								type="button"
								className={styles.dictationAction}
								data-action="record"
								onPointerDown={keepFocus}
								onClick={onRecord}
								aria-label="Start dictation"
								title="Start dictation"
							>
								<RecordIcon />
							</button>
						)}
					</span>
				</>
			)}
		</div>
	);
});

function noop(): void {
	// A null controller has no listeners to release.
}
