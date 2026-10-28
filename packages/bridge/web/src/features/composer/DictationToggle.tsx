// ============================================================================
// DictationToggle — the composer's microphone: a disclosure, not a transport.
//
// It has one meaning — show or hide the dictation toolbar — which is why it is
// a plain `aria-expanded`/`aria-controls` button instead of the ASR package's
// `bindButton` affordance. Every state transition lives in the toolbar, so the
// mic never has to express "preparing" or "listening" through its colour, and a
// press can never throw a transcript away by accident: closing the toolbar
// keeps.
//
// A press only discloses: nothing is captured until the toolbar's own record
// control is pressed. That keeps one intent per press — "show me the controls"
// never asks for the microphone — and the record press is still a user gesture,
// so `getUserMedia` is reached without an await in between. The disclosure
// flag is persisted (see `dictationToolbarPreference`), so the panel reopens as
// the user left it.
//
// A microphone that cannot start is not disabled: the press opens the toolbar,
// which states the reason in place (see DictationToolbar). A disabled target
// with a tooltip explains nothing on a touch screen, where there is no hover.
// ============================================================================

import { memo } from "react";
import { MicIcon } from "../../render/icons.tsx";
import styles from "./ComposeCard.module.css";

/** The toolbar's `aria-controls` target; one composer per surface, so it is a
 * constant rather than a generated id. */
export const DICTATION_TOOLBAR_ID = "dictation-toolbar";

/** Pressing a compose control must not take focus: the field owns the caret and,
 * on touch, the soft keyboard. `preventDefault` on `pointerdown` keeps it there
 * and does not suppress the click. */
const keepFocus = (event: React.PointerEvent): void => event.preventDefault();

export const DictationToggle = memo(function DictationToggle({
	open,
	onToggle,
}: {
	open: boolean;
	onToggle: () => void;
}) {
	const name = open ? "Hide dictation controls" : "Show dictation controls";

	return (
		<button
			type="button"
			className={styles.dictationBtn}
			aria-expanded={open}
			aria-controls={open ? DICTATION_TOOLBAR_ID : undefined}
			title={name}
			aria-label={name}
			data-on={open || undefined}
			onPointerDown={keepFocus}
			onClick={onToggle}
		>
			<MicIcon />
		</button>
	);
});
