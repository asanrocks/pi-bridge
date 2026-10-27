// ============================================================================
// useDictation — dictation in the composer, as one hook.
//
// The document is the store draft, but the *editor* is the mounted textarea:
// `attachInput` writes through `setRangeText` and dispatches `input`, which is
// what makes React's value tracker accept the transcript as typing (and what
// keeps the commit on the native undo stack, so one Ctrl+Z removes the
// utterance). The hook therefore attaches to whatever element `textareaRef`
// points at after every render, and re-attaches only when that element changes
// (a collapse/expand swap costs nothing).
//
// Three consequences are deliberate:
//
//   - The field is locked while an utterance runs (edits refused, Send and
//     Enter blocked). "Replace the span this dictation owns" and "the user is
//     typing into that span" cannot both be true, so the composer picks one.
//     The refusal is `beforeinput`, not `readOnly`: a focused textarea that
//     turns read-only loses its IME connection on Android, so the soft keyboard
//     closes at start and reopens at settle, flashing the composer on every
//     utterance. `committing` is not part of the refusal — the ASR package
//     writes the terminal transcript through the native edit command, which is
//     what keeps the utterance one undo step.
//   - Ending is explicit: the toolbar's own controls, Escape, closing the
//     toolbar (which keeps), the surface unmounting, or an external edit to the
//     field. A plain blur does not end an utterance — no dictation control takes
//     focus (each prevents its `pointerdown`), so pressing one does not collapse
//     the composer under the recording.
//   - The state machine is the toolbar's, not the microphone's. The mic is a
//     disclosure (`openToolbar`) and the transport lives beside the text it
//     affects: record, keep, discard. Opening only shows the panel — nothing is
//     captured until the record control is pressed, and that press is the
//     gesture `getUserMedia` needs; the panel then stays open across utterances
//     so a repeat is one press, and closing it keeps rather than discards. The
//     disclosure flag is a device preference (`dictationToolbarPreference`), so
//     the panel is where the user left it after a reload or a Session switch.
//   - One utterance belongs to one draft (see DraftOwnership). A draft swap
//     changes the field's text, so the utterance ends with the document it
//     started in and its late results are refused rather than written at stale
//     offsets.
//
// Polish shares the field, the lock and the toolbar, but not the controller: it
// is one daemon round trip over the whole draft, so it has no phases of its own
// beyond running/answered (`PolishState`). It claims the draft like an utterance,
// because a reply that outlived a Session switch describes text that is no
// longer on screen. What it installs is remembered as a *replacement* — the
// changed region plus the text it replaced (see `textPolish.ts`) — inside the
// same single undo slot as a dictation commit: one toolbar control, one meaning,
// "take back what I just did", which is what a phone without Ctrl+Z offers.
//
// Availability is a capability answer, not an error: no secure context, no
// daemon connection, or no credential leaves the toolbar without a record
// control and states the reason in place (`dictationPolicy`) — the same row that
// owns every other dictation ending, so no notice has to interrupt the user.
// Credentials are prefetched, not fetched on demand:
// a page can neither mint a SAMI token nor register a device, so the daemon
// provides one (`asrCredentials`) — and `getUserMedia` must be reached inside
// the gesture, without an RPC await in between. The ASR session itself runs from
// this page to the endpoint, so a credential outliving the socket is expected;
// only starting needs the connection.
// ============================================================================

import { Dictation, type DictationPhase, isFatalError } from "@earendil-works/pi-asr/dictation";
import { attachInput, type TextTarget } from "@earendil-works/pi-asr/dom";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AsrCredential } from "../../../../src/core/index.ts";
import { isInsecureOrigin, noteSecureContextFailure } from "../../infra/lib/secureContext.ts";
import { asrCredentialsRpc, textPolishRpc } from "../../infra/net/useRpc.ts";
import { getStore } from "../../infra/state/store.tsx";
import {
	asDictationEnding,
	credentialRetryDelay,
	dictationAvailability,
	dictationEndingNotice,
	TOKEN_REFRESH_MARGIN_MS,
} from "./dictationPolicy.ts";
import { loadDictationToolbarOpen, saveDictationToolbarOpen } from "./dictationToolbarPreference.ts";
import { DraftOwnership } from "./draftOwnership.ts";
import { changedSpan, installedSpan, isStillApplied, type PolishState, type TextEdit } from "./textPolish.ts";

/** Stable idle snapshot for the no-controller case: `useSyncExternalStore`
 * compares by reference, so a fresh `{ kind: "idle" }` per render would loop. */
const IDLE: DictationPhase = { kind: "idle" };

/** Stable idle snapshot for polish, for the same reference-comparison reason. */
const POLISH_IDLE: PolishState = { kind: "idle" };

/** What a host that has no element to read reports. The editing model treats it
 * as drift and drops the dictation rather than writing somewhere else. */
const NO_ELEMENT = { text: "", caret: 0 };

/** A composer whose microphone never delivers is a capture failure, not a slow
 * one: fail visibly instead of leaving the button spinning. Generous enough to
 * cover a first-use permission prompt, which is the same `preparing` phase. */
const PREPARING_TIMEOUT_MS = 30_000;

/** The worklet, as an emitted asset rather than the package's default.
 * `openMicrophone` defaults to `new URL('./worklet.js', import.meta.url)`, which
 * Vite always inlines as a `data:` URL — and a worklet must be loadable from a
 * same-origin file. `?no-inline` keeps it a file beside the other assets, which
 * the daemon (and the single-file bundle's embedded assets) serve. */
const workletUrl = new URL("../../../../../asr/src/mic/worklet.js?no-inline", import.meta.url).href;

/** `setTimeout`'s ceiling; a token could outlive it, and an overflowing delay
 * fires immediately. */
const MAX_TIMER_MS = 2_147_483_647;

export interface ComposerDictation {
	/** The controller, or null until credentials arrive on a secure origin. */
	dictation: Dictation | null;
	/** Why the control cannot start now, or null when it can. Non-null with a
	 * controller of its own means "running, but no longer startable". */
	reason: string | null;
	/** The utterance owns the field: text, Send, and Enter are locked. */
	locked: boolean;
	/** Edits are refused in place (`beforeinput`): the dictation is rewriting its
	 * span. Narrower than {@link locked} by `committing`, whose write is the ASR
	 * package's own native edit command. */
	editsBlocked: boolean;
	/** What the idle row's undo would take back, or null when there is nothing
	 * to take back. One slot for both operations: the last thing this composer
	 * did to the text, not a history. */
	undoKind: "dictation" | "polish" | null;
	/** Take back the last committed transcript or install, if the field still
	 * holds it. */
	undoLast: () => void;
	// ── Text polish ───────────────────────────────────────────────────────
	// One daemon round trip over the whole draft: no controller, no phases.
	/** The last polish attempt, for the idle row. */
	polish: PolishState;
	/** There is a connection to ask the daemon for a rewrite. */
	canPolish: boolean;
	/** Send the whole draft to the daemon and install what comes back. */
	polishDraft: () => void;
	/** Stop waiting for an answer. The daemon's own request finishes inside its
	 * timeout; the reply is dropped rather than written. */
	cancelPolish: () => void;
	// ── The dictation toolbar ─────────────────────────────────────────────
	// The microphone is a disclosure, not a transport: it shows the toolbar, and
	// every state transition is one of the toolbar's own controls. That keeps one
	// control per meaning — the alternative made the mic a three-phase state
	// machine whose only vocabulary was its colour.
	/** The toolbar is showing. */
	toolbarOpen: boolean;
	/** Show the toolbar. A disclosure only: recording is the toolbar's own
	 * control, so a press that means "show me the controls" never asks for the
	 * microphone. */
	openToolbar: () => void;
	/** Hide the toolbar. A running utterance is kept, never dropped: discard is a
	 * control of its own. */
	closeToolbar: () => void;
	toggleToolbar: () => void;
	/** Toolbar transport. Each one hands focus back to the field afterwards, where
	 * the text is going and where the soft keyboard's caret belongs. */
	record: () => void;
	/** Keep: finish now and insert the transcript. */
	commit: () => void;
	/** Discard: drop the utterance; nothing is reported and nothing is kept. */
	cancel: () => void;
}

export function useDictation(options: {
	textareaRef: React.RefObject<HTMLTextAreaElement | null>;
	/** False while there is no daemon connection to ask for credentials. */
	enabled: boolean;
	/** The draft the field shows — an address pair, a Project draft slot. A
	 * change ends the utterance: the span it owns belongs to the document that
	 * was there before. */
	scope: string;
}): ComposerDictation {
	const { textareaRef, enabled, scope } = options;
	const insecure = isInsecureOrigin();

	const [credential, setCredential] = useState<AsrCredential | null>(null);
	const [credentialError, setCredentialError] = useState<string | null>(null);
	/** The dictation toolbar's disclosure state. UI state, not the controller's:
	 * the panel outlives an utterance so a second one is one press away, and it
	 * is persisted because it describes this device, not this draft. */
	const [toolbarOpen, setToolbarOpen] = useState(loadDictationToolbarOpen);
	/** Read inside the session factory, which runs per utterance: a refreshed
	 * token must be picked up without rebuilding the controller. */
	const credentialRef = useRef<AsrCredential | null>(null);
	const dictationRef = useRef<Dictation | null>(null);
	/** The fetch the current effect installed, so an event can ask for a new one
	 * (a rejected token, a token near expiry) without re-running the effect. */
	const requestRef = useRef<() => void>(() => undefined);
	const reloadCredentials = useCallback(() => requestRef.current(), []);

	// ── Credentials ─────────────────────────────────────────────────────
	// Asked for on mount, on reconnect, on a rejected token, and near a minted
	// token's expiry. A failure is retried with backoff: a provider that is
	// briefly unreachable must not leave the control dead until a reload.
	useEffect(() => {
		if (!enabled || insecure) return;
		let cancelled = false;
		let attempt = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const request = (): void => {
			void asrCredentialsRpc().then((result) => {
				if (cancelled) return;
				if ("error" in result) {
					setCredentialError(result.error);
					timer = setTimeout(request, credentialRetryDelay(attempt));
					attempt += 1;
					return;
				}
				attempt = 0;
				credentialRef.current = result.auth;
				setCredentialError(null);
				setCredential(result.auth);
			});
		};
		requestRef.current = request;
		request();

		return () => {
			cancelled = true;
			requestRef.current = () => undefined;
			if (timer !== undefined) clearTimeout(timer);
		};
	}, [enabled, insecure]);

	// A minted token is cached here, so refresh it just inside the daemon's own
	// refresh window instead of discovering the expiry mid-utterance. The answer is
	// then a new token, whose expiry re-arms this effect.
	const tokenExpiry = credential !== null && credential.kind === "token" ? credential.expiresAt : null;
	useEffect(() => {
		if (tokenExpiry === null) return;
		const delay = tokenExpiry - TOKEN_REFRESH_MARGIN_MS - Date.now();
		if (delay <= 0) {
			reloadCredentials();
			return;
		}
		const timer = setTimeout(reloadCredentials, Math.min(delay, MAX_TIMER_MS));
		return () => clearTimeout(timer);
	}, [tokenExpiry, reloadCredentials]);

	// ── Draft ownership ─────────────────────────────────────────────────
	const attachedRef = useRef<{ element: HTMLTextAreaElement; target: TextTarget } | null>(null);
	// Created once for this surface: a re-render must not forget which draft the
	// running utterance owns.
	const [ownership] = useState(() => new DraftOwnership(scope));
	/** The last thing this composer did to the draft, as the replacement it made:
	 * what the toolbar's Undo takes back, verified against the field first. Both
	 * operations share the slot — it is "the last edit", not a stack. */
	const undoRef = useRef<{ kind: "dictation" | "polish"; edit: TextEdit } | null>(null);
	/** The ref is the truth; this is its render-visible shadow, because the
	 * toolbar only offers Undo while there is something to take back. */
	const [undoKind, setUndoKind] = useState<"dictation" | "polish" | null>(null);
	/** The last polish attempt. `running` locks the field, like an utterance. */
	const [polish, setPolish] = useState<PolishState>(POLISH_IDLE);
	/** Identifies the request whose answer still matters. Cancelling clears it,
	 * so a late reply is dropped instead of written. */
	const polishRequestRef = useRef<object | null>(null);

	// The editing model writes into the element, so the host is a stable facade
	// over whichever element is mounted right now and over the draft it belongs to.
	const host = useMemo(
		() => ({
			apply: (batch: Parameters<TextTarget["apply"]>[0]) => {
				// The utterance's draft is gone: nothing it produces may reach the
				// field. Discarding is part of the ending — the scope change below
				// cancels the rest of the utterance.
				if (!ownership.writable) return;
				const attached = attachedRef.current;
				if (attached === null) return;
				attached.target.apply(batch);
				// A commit is the one write worth remembering, and the text is read
				// back out of the field afterwards: that is the terminal transcript,
				// not the last pre-edit, and it is what Undo must find still there.
				if (batch.kind === "commit" && batch.span.end > batch.span.start) {
					const text = attached.target.read().text.slice(batch.span.start, batch.span.end);
					// A transcript replaces nothing: it lands in the empty span the
					// dictation owned.
					undoRef.current = {
						kind: "dictation",
						edit: { span: { start: batch.span.start, end: batch.span.start }, inserted: text, replaced: "" },
					};
					setUndoKind("dictation");
				}
			},
			// A draft this utterance does not own reports no text, which the editing
			// model reads as drift and abandons instead of writing at stale offsets.
			read: () => (ownership.writable ? (attachedRef.current?.target.read() ?? NO_ELEMENT) : NO_ELEMENT),
		}),
		[ownership],
	);

	// A controller needs a credential and a secure origin. The connection is a
	// start gate, not a construction one: the ASR stream never used the socket, so
	// losing it must not dispose a running utterance.
	const ready = !insecure && credential !== null;
	const dictation = useMemo(() => {
		if (!ready) return null;
		return new Dictation({
			// Rebuilt per utterance, so this closure is where a refreshed
			// credential enters. The browser can only use the JSON wire: it cannot
			// set the `proto-version` header.
			session: () => {
				const auth = credentialRef.current;
				return {
					wire: "json",
					auth: auth?.kind === "token" ? { token: auth.token } : { device: { deviceId: deviceIdOf(auth) } },
				};
			},
			host,
			// Claimed inside the gesture, before any await: the offsets this
			// utterance owns describe the field as the user sees it right now.
			caret: () => {
				ownership.claim();
				// A new utterance ends the previous operation's undo: the offset it
				// owned describes text the next utterance is about to rewrite.
				undoRef.current = null;
				setUndoKind(null);
				return attachedRef.current?.target.read().caret ?? 0;
			},
			// Click to start, click to stop: the same gesture on a mouse and on a
			// touch screen, and a short tap cannot cancel itself while the
			// permission prompt or the handshake is still pending.
			mode: "toggle",
			// §5.7: echo cancellation costs recognition quality, noise suppression
			// helps. The level meter reads what the ASR is about to see.
			mic: { workletUrl, audio: { echoCancellation: false, noiseSuppression: true } },
			preparingTimeoutMs: PREPARING_TIMEOUT_MS,
		});
	}, [ready, host, ownership]);

	useEffect(() => {
		dictationRef.current = dictation;
	}, [dictation]);

	// One utterance belongs to one document. Ownership moves first, so the
	// cancellation below cannot write its pre-edit removal into the new draft.
	useEffect(() => {
		if (!ownership.setCurrent(scope)) return;
		// The edit Undo would take back belongs to the draft that just left the
		// screen.
		undoRef.current = null;
		setUndoKind(null);
		void dictationRef.current?.cancel();
	}, [ownership, scope]);

	useEffect(() => {
		if (dictation === null) return;
		return () => {
			// `dispose()` is the unmounting surface's ending: it cancels the
			// utterance and drops the listeners. A remount (StrictMode, another
			// surface) starts from idle.
			void dictation.dispose();
		};
	}, [dictation]);

	// ── Target attachment ──────────────────────────────────────────────
	// Runs after every render; the comparison makes it a no-op unless the
	// composer mounted, remounted, or collapsed.
	useEffect(() => {
		const element = textareaRef.current;
		const attached = attachedRef.current;
		if (attached !== null && attached.element === element) return;
		attached?.target.detach();
		attachedRef.current = null;
		if (element !== null) {
			attachedRef.current = {
				element,
				// Typing, pasting, or another script writing into the field: the span
				// this dictation owns is no longer trustworthy, so the user's text
				// wins. The composer's refusal only covers `preparing`/`listening`, so
				// this also fires for edits made while `committing`, and for any
				// programmatic write.
				target: attachInput(element, { onExternalEdit: () => void dictationRef.current?.cancel() }),
			};
			return;
		}
		// The field is gone (collapsed composer, another surface): the utterance
		// has no document to write into, and a polish still in flight has no span
		// to land in. The toolbar goes with the field because it is rendered inside
		// the card, but the disclosure flag is remembered, so expanding the card
		// again brings the panel back as the user left it.
		if (dictationRef.current?.isActive) void dictationRef.current.cancel();
		polishRequestRef.current = null;
		setPolish(POLISH_IDLE);
	});

	useEffect(
		() => () => {
			attachedRef.current?.target.detach();
			attachedRef.current = null;
			// The surface is gone: an answer still in flight has no field to land in.
			polishRequestRef.current = null;
		},
		[],
	);

	const phase = useSyncExternalStore(
		useCallback((notify: () => void) => dictation?.subscribe(notify) ?? noop, [dictation]),
		useCallback(() => dictation?.phase ?? IDLE, [dictation]),
	);

	// Availability is decided before the transport: a control that could start an
	// utterance the daemon cannot authorize is refused rather than attempted.
	const availability = dictationAvailability({ connected: enabled, insecure, credential, credentialError });
	const reason = availability.ready ? null : availability.reason;

	// ── Endings and the toolbar ────────────────────────────────────────
	// Every toolbar press replaces or removes the button that was pressed (the row
	// is phase-driven), and on touch the field owns the soft keyboard: so each one
	// ends by putting focus back where the text is going.
	const focusField = useCallback(() => {
		attachedRef.current?.element.focus();
	}, []);

	const record = useCallback(() => {
		// Starting is what the policy gates, and the toolbar states the reason in
		// place; finishing is not gated, so a dropped socket leaves a running
		// utterance's controls live.
		if (reason !== null) return;
		// A new operation on the text: the last polish's answer is history.
		setPolish(POLISH_IDLE);
		void dictationRef.current?.start();
		focusField();
	}, [reason, focusField]);

	const commit = useCallback(() => {
		void dictationRef.current?.stop();
		focusField();
	}, [focusField]);

	const cancel = useCallback(() => {
		void dictationRef.current?.cancel();
		focusField();
	}, [focusField]);

	const openToolbar = useCallback(() => {
		setToolbarOpen(true);
		saveDictationToolbarOpen(true);
	}, []);

	const closeToolbar = useCallback(() => {
		setToolbarOpen(false);
		saveDictationToolbarOpen(false);
		// Keep, never discard — and `stop()` on an idle controller is a no-op.
		void dictationRef.current?.stop();
		focusField();
	}, [focusField]);

	const toggleToolbar = useCallback(() => {
		if (toolbarOpen) closeToolbar();
		else openToolbar();
	}, [toolbarOpen, openToolbar, closeToolbar]);

	// Undo writes through the same IME-shaped path a cancellation uses
	// (`TextTarget.apply`), not a native undo command: the stack would undo
	// whatever the user typed last, and neither a transcript nor a polish is
	// necessarily the top step by the time the control is pressed. What it leaves
	// behind is one no-op stack entry — undoing it restores text the field no
	// longer holds.
	//
	// One slot covers both operations. A transcript put text where there was
	// none; a polish replaced a region with another (`textPolish.ts`). Undoing
	// either is the same write: the replaced text goes back over the installed
	// text, and only if that text is still exactly there.
	const undoLast = useCallback(() => {
		const undo = undoRef.current;
		const attached = attachedRef.current;
		undoRef.current = null;
		setUndoKind(null);
		// Nothing to report when the answer is no: the control is only offered
		// while the install is still in the field, and an edit that outran the
		// press simply leaves the text alone.
		if (undo === null || attached === null || !ownership.writable) return;
		if (!isStillApplied(attached.target.read().text, undo.edit)) return;
		const span = installedSpan(undo.edit);
		attached.target.apply({
			// The DOM target only uses `group` for native undo grouping, which the
			// adapter's own commit owns; a removal needs none.
			group: 0,
			kind: "cancel",
			span,
			ops: [{ ...span, text: undo.edit.replaced }],
		});
	}, [ownership]);

	// ── Text polish ────────────────────────────────────────────────────
	// The whole draft in, the rewritten whole draft out, installed as the one
	// region that differs. The field is locked for the round trip (see `locked`
	// below): the answer replaces text, so "the user is typing into it" and "the
	// answer is about to land" cannot both be true, and a lock is the only option
	// that cannot silently lose what was typed.
	//
	// The reply is verified against the snapshot that was sent, not trusted: an
	// external write (another tab's draft sync, an autofill) can reach the field
	// even with `beforeinput` refused, and installing a whole-draft rewrite over
	// text nobody polished would be the worst outcome available.
	// Only the connection is required: the daemon holds both the protocol and the
	// identity, and no secure context is involved. A press is the whole
	// authorisation — the control says where the text goes.
	const canPolish = enabled;

	const polishDraft = useCallback(() => {
		if (!canPolish || polish.kind === "running") return;
		// An utterance owns the field while it runs; the toolbar hides this control
		// then, so this only guards a stray press.
		if (dictationRef.current?.isActive === true) return;
		const attached = attachedRef.current;
		if (attached === null) return;
		const before = attached.target.read().text;
		if (before.trim() === "") return;
		// The draft that answered is the draft it must return into.
		ownership.claim();
		// A polish is a new operation: whatever the previous one could take back is
		// about to describe text this one rewrites.
		undoRef.current = null;
		setUndoKind(null);
		setPolish({ kind: "running" });
		const request = {};
		polishRequestRef.current = request;
		void textPolishRpc(before).then((result) => {
			// Cancelled, superseded, or the surface unmounted: the answer is about
			// text this control no longer owns.
			if (polishRequestRef.current !== request) return;
			polishRequestRef.current = null;
			if (!ownership.writable) {
				setPolish(POLISH_IDLE);
				return;
			}
			if ("error" in result) {
				setPolish({ kind: "failed", reason: result.error });
				return;
			}
			const element = attachedRef.current;
			if (element === null || element.target.read().text !== before) {
				setPolish({ kind: "failed", reason: "The draft changed while polishing, so the result was dropped." });
				return;
			}
			const edit = changedSpan(before, result.text);
			if (edit === null) {
				// The service's own answer for text that needs no arranging.
				setPolish({ kind: "unchanged" });
				return;
			}
			setPolish(POLISH_IDLE);
			element.target.apply({
				group: 0,
				kind: "cancel",
				span: installedSpan(edit),
				ops: [{ ...edit.span, text: edit.inserted }],
			});
			undoRef.current = { kind: "polish", edit };
			setUndoKind("polish");
			focusField();
		});
	}, [canPolish, polish.kind, ownership, focusField]);

	const cancelPolish = useCallback(() => {
		// The client has no request cancellation, so this stops *waiting*: the
		// daemon's exchange finishes inside its own timeout and the reply is
		// dropped by the guard above.
		polishRequestRef.current = null;
		setPolish(POLISH_IDLE);
		focusField();
	}, [focusField]);

	// ── Settled utterances ─────────────────────────────────────────────
	// One result per utterance, reported once: a fatal reason is a failure the
	// user must see, a non-fatal one is a notice because the text was kept, and a
	// cancellation has nothing to report. The upserting toast id is the dedupe,
	// so a repeated notice never stacks.
	useEffect(() => {
		if (dictation === null) return;
		return dictation.onSettled((result) => {
			const error = result.error;
			if (error === null) return;
			const store = getStore().getState();
			if (isFatalError(error)) {
				store.pushToast("dictation", `Dictation failed: ${error.message}`);
				if (error.code === "unsupported" || error.code === "capture") noteSecureContextFailure();
				// A rejected credential is routine for a token: refresh it so the next
				// press works without a reload.
				if (error.code === "auth_expired") reloadCredentials();
				return;
			}
			const ending = asDictationEnding(error.code);
			store.pushToast(
				"dictation-ending",
				ending === null ? `Dictation ended: ${error.message}` : dictationEndingNotice(ending),
			);
		});
	}, [dictation, reloadCredentials]);

	return {
		dictation,
		reason,
		// `committing` is part of the utterance: the terminal transcript is still
		// on its way into the field. A polish owns the field the same way, for the
		// length of one round trip.
		locked:
			phase.kind === "preparing" ||
			phase.kind === "listening" ||
			phase.kind === "committing" ||
			polish.kind === "running",
		editsBlocked: phase.kind === "preparing" || phase.kind === "listening" || polish.kind === "running",
		undoKind,
		undoLast,
		polish,
		canPolish,
		polishDraft,
		cancelPolish,
		toolbarOpen,
		openToolbar,
		closeToolbar,
		toggleToolbar,
		record,
		commit,
		cancel,
	};
}

function noop(): void {
	// A null snapshot has no listeners to release.
}

/** Only reachable through the `ready` guard; the empty string keeps the
 * session factory total instead of throwing out of a gesture handler. */
function deviceIdOf(credential: AsrCredential | null): string {
	return credential !== null && credential.kind === "device" ? credential.deviceId : "";
}
