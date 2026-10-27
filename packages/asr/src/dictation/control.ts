/**
 * One dictation: microphone, session, editing model, and the states a button
 * needs. This is the only module allowed to know all four at once — it orders
 * them, it does not translate anything, which is why it is not a layer.
 *
 * Boundaries it keeps:
 *
 * - It never touches the DOM. Text goes through an {@link EditHost}, and the
 *   insertion point comes from `caret()`, so a store-backed React composer and
 *   a bare `<textarea>` take the same path.
 * - It never touches the wire. `AsrSession` is injected, so the same controller
 *   drives a real socket, a mock transport, or a test double.
 * - It fires and forgets: `start()` does not reject. A failed start lands in the
 *   `failed` phase with an `AsrError`, exactly like `push()` never throwing — the
 *   caller is inside a pointer handler, not an await.
 *
 * Cancellation is the caller's ending and outranks the server's. `cancel()` bumps
 * a generation counter, so a `finish()` still in flight when the user gives up
 * settles into nothing: the outcome belongs to a document the caller already
 * abandoned, and writing it there would put the old utterance's text into
 * whatever is mounted now.
 *
 * Two decisions are protocol facts, not presentation:
 *
 * - `listening` begins at the first audio batch: not at a level threshold, and
 *   not at the handshake. Noise suppression removes the room floor
 *   (`docs/protocol.md` §5.7), so a threshold would never be met in a quiet room,
 *   and waiting for the network would present a working microphone as "still
 *   preparing". `sending` reports the handshake on its own, because until it
 *   lands the frames wait in the session's pre-roll instead of going out.
 * - `expired` is not a `failed` state. The server ends the task after ~20 s
 *   without audio (§5.6), which is a normal outcome; the text is committed and
 *   the error is reported, but the button returns to `idle`.
 *
 * "The utterance" spans three phases with one lifetime: `active` while capture
 * runs, `settling` while the terminal outcome is awaited. Both are reported by
 * {@link Dictation.isActive}, because the button and the host must treat
 * `committing` as still running, not as free to start another utterance.
 */
import { AsrSession as BrowserAsrSession } from "../browser.ts";
import type { EditHost } from "../edit/dictation.ts";
import { DictationEdit } from "../edit/dictation.ts";
import type { AsrErrorCode } from "../errors.ts";
import { AsrError } from "../errors.ts";
import type { Microphone, MicrophoneOptions } from "../mic/capture.ts";
import { openMicrophone } from "../mic/capture.ts";
import type { AsrSession, AsrSessionOptions, FinishOutcome } from "../session.ts";
import type { LevelOptions, LevelReading } from "./level.ts";
import { LevelMeter } from "./level.ts";

/**
 * `hold` is press-to-talk, `toggle` is click-to-start/click-to-stop, and `auto`
 * lets the affordance read the gesture: a finger or a pen holds, a mouse and a
 * keyboard latch. `auto` is the default because the same page is built for both.
 */
export type DictationMode = "hold" | "toggle" | "auto";

export type DictationPhase =
	| { kind: "idle" }
	/**
	 * No audio yet. Permission and device open are inseparable from here —
	 * `getUserMedia` reports neither until it reports both — so this is "why no
	 * audio", whatever the reason.
	 */
	| { kind: "preparing" }
	/**
	 * Audio is arriving. `sending` is false while the handshake is still in
	 * flight, during which the session holds the frames in its pre-roll.
	 */
	| { kind: "listening"; sending: boolean }
	| { kind: "committing" }
	/** A failure the caller should show and the user may retry. */
	| { kind: "failed"; error: AsrError };

export interface DictationResult {
	/** The committed transcript, or null when nothing was committed. */
	text: string | null;
	/** The session outcome when the finish request ran; null when it never could. */
	finish: FinishOutcome | null;
	/** Why it ended without a clean commit, or the expiry/timeout that still committed. */
	error: AsrError | null;
}

/**
 * How one utterance ended, delivered once by {@link Dictation.onSettled}.
 *
 * A cancellation is the empty result: nothing was committed (`text` null), no
 * finish request ran (or the answer was discarded), and there is nothing to
 * report (`error` null). Anything the caller must show lives in `result.error`,
 * classified by {@link isFatalError}.
 */
export type DictationSettlementListener = (result: DictationResult) => void;

export interface DictationOptions {
	/** Per utterance. A factory is called once per `start()`. */
	session: AsrSessionOptions | (() => AsrSessionOptions);
	/** Where the text goes: a text field adapter, or a store document (`applyBatch`). */
	host: EditHost;
	/**
	 * The insertion point, read inside the gesture that starts the dictation.
	 * Optional: a host whose `read()` also reports a caret (an `input`/`textarea`
	 * target) already knows, so only a store document has to say.
	 */
	caret?: () => number;
	mode?: DictationMode;
	/**
	 * Capture options minus the two callbacks this layer owns. Put the ASR
	 * constraints here: `docs/protocol.md` §5.7 records that echo cancellation is
	 * usually a net loss for recognition.
	 */
	mic?: Omit<MicrophoneOptions, "onPcm" | "onEnded">;
	level?: LevelOptions;
	/**
	 * Fail `preparing` when no audio arrives within this long. 0 (default) waits
	 * forever, which is honest but leaves a dead device looking like a slow one.
	 */
	preparingTimeoutMs?: number;
	/** Test seams, mirroring `Transport` on the session. */
	openMic?: (options: MicrophoneOptions) => Promise<Microphone>;
	createSession?: (options: AsrSessionOptions) => AsrSession;
	now?: () => number;
}

/** The session is over; a fresh one is the remedy, so the button must not stick. */
const NON_FATAL: ReadonlySet<AsrErrorCode> = new Set<AsrErrorCode>(["expired", "aborted", "timeout"]);

/**
 * True when the utterance ended for a reason the caller has to surface.
 *
 * `expired`, `aborted`, and `timeout` close the session without breaking the
 * button — the text is kept and the reason is advisory — so a host shows them as
 * a passing notice rather than a failure. Exported because a host reading
 * settlement results must not re-derive this classification from `code`.
 */
export function isFatalError(error: AsrError): boolean {
	return !NON_FATAL.has(error.code);
}

const EMPTY_RESULT: DictationResult = { text: null, finish: null, error: null };

export class Dictation {
	private readonly options: DictationOptions;
	private readonly meter: LevelMeter;
	private readonly now: () => number;
	private readonly caret: () => number;

	private phaseValue: DictationPhase = { kind: "idle" };
	private readonly phaseListeners = new Set<(phase: DictationPhase) => void>();
	private readonly levelListeners = new Set<(reading: LevelReading) => void>();
	private readonly settlementListeners = new Set<DictationSettlementListener>();

	/** Counts started utterances; a settlement is delivered once per id. */
	private utterance = 0;
	private settledUtterance = 0;

	private edit: DictationEdit | undefined;
	private session: AsrSession | undefined;
	private mic: Microphone | undefined;
	private readyTimer: ReturnType<typeof setTimeout> | undefined;
	/**
	 * Guards every asynchronous continuation: `cancel()` and a failed start bump
	 * it, so a permission prompt answered seconds later cannot resurrect an
	 * utterance the user already dismissed.
	 */
	private generation = 0;
	private active = false;
	/** A terminal outcome is in flight: `stop()` or a terminal message asked the
	 * server for the transcript and nothing may start until it lands. */
	private settling = false;
	private sessionOpen = false;
	private micReady = false;
	private lastResult: DictationResult = EMPTY_RESULT;

	constructor(options: DictationOptions) {
		this.options = options;
		this.meter = new LevelMeter(options.level ?? {});
		this.now = options.now ?? Date.now;
		this.caret = options.caret ?? caretFromHost(options.host);
	}

	get phase(): DictationPhase {
		return this.phaseValue;
	}

	/** The button layer branches on this; see {@link DictationMode}. */
	get mode(): DictationMode {
		return this.options.mode ?? "auto";
	}

	/** True while an utterance runs, including the wait for its terminal outcome. */
	get isActive(): boolean {
		return this.active || this.settling;
	}

	/** The last settled utterance, including why it ended. */
	get result(): DictationResult {
		return this.lastResult;
	}

	/** Discrete state; a few notifications per utterance, safe for React. */
	subscribe(listener: (phase: DictationPhase) => void): () => void {
		this.phaseListeners.add(listener);
		return () => {
			this.phaseListeners.delete(listener);
		};
	}

	/** Continuous level, ~50 Hz. Keep it away from a store or a render loop. */
	onLevel(listener: (reading: LevelReading) => void): () => void {
		this.levelListeners.add(listener);
		return () => {
			this.levelListeners.delete(listener);
		};
	}

	/**
	 * One settlement per started utterance: committed, cancelled, expired,
	 * timed out, or failed.
	 *
	 * Independent of {@link subscribe}'s phases, which are discrete UI states and
	 * say nothing about what was produced. Listeners run after the text outcome
	 * reached the host and after `phase` and `result` were updated, so both can be
	 * read inside the callback. Nothing is delivered for an utterance that never
	 * started.
	 */
	onSettled(listener: DictationSettlementListener): () => void {
		this.settlementListeners.add(listener);
		return () => {
			this.settlementListeners.delete(listener);
		};
	}

	/**
	 * Begin a dictation. Call synchronously from the gesture handler: the
	 * microphone is opened in the same task so a browser that requires user
	 * activation for audio still gets it.
	 *
	 * Resolves once both waits settled — successfully or into `failed`.
	 */
	async start(): Promise<void> {
		if (this.isActive) return;
		this.generation += 1;
		this.utterance += 1;
		const generation = this.generation;
		this.active = true;
		this.sessionOpen = false;
		this.micReady = false;
		this.lastResult = EMPTY_RESULT;
		this.meter.reset();
		this.setReading({ level: 0, speaking: false });
		this.setPhase({ kind: "preparing" });

		// Captured now, before any await: a permission prompt must not decide where
		// the sentence lands.
		let offset: number;
		try {
			offset = this.caret();
		} catch (error) {
			await this.fail(error, generation);
			return;
		}
		const edit = new DictationEdit(this.options.host);
		edit.begin(offset);
		this.edit = edit;

		const session = this.createSession();
		this.session = session;
		this.armReadyTimer(generation);
		void this.drain(session, edit, generation);

		// Both waits start together and neither is awaited in turn, so the session
		// handshake overlaps the permission prompt (§5.6: hide it in the first
		// second of speech).
		await this.open(session, generation);
	}

	/** Release: stop capture, finish the session, commit or cancel the pre-edit. */
	async stop(): Promise<DictationResult> {
		return this.finishUtterance();
	}

	/**
	 * Throw the utterance away: the host gets a `cancel` batch, not a commit.
	 *
	 * Cancelling during `committing` is the case that needs the generation: the
	 * finish request is already out, so this cannot prevent the server's answer —
	 * it takes ownership of the ending so that answer is discarded.
	 */
	async cancel(): Promise<void> {
		if (!this.isActive) {
			this.setPhase({ kind: "idle" });
			return;
		}
		this.generation += 1;
		this.active = false;
		this.settling = false;
		this.clearReadyTimer();
		const { session, edit, mic } = this.detach();
		edit?.cancel();
		await mic?.stop().catch(() => undefined);
		await session?.close("dictation cancelled").catch(() => undefined);
		this.setPhase({ kind: "idle" });
		this.settle(EMPTY_RESULT);
	}

	/** `cancel()` plus listener cleanup, for a component that is going away. */
	async dispose(): Promise<void> {
		await this.cancel();
		this.phaseListeners.clear();
		this.levelListeners.clear();
		this.settlementListeners.clear();
	}

	// ── opening ───────────────────────────────────────────────────────────

	private createSession(): AsrSession {
		const options = typeof this.options.session === "function" ? this.options.session() : this.options.session;
		const create = this.options.createSession;
		return create === undefined ? new BrowserAsrSession(options) : create(options);
	}

	/**
	 * Resolve when both halves are open, or as soon as one of them fails.
	 *
	 * `Promise.all` would be wrong in the failure case: a denied permission would
	 * leave the button stuck until the handshake timeout, seconds later.
	 */
	private open(session: AsrSession, generation: number): Promise<void> {
		return new Promise<void>((resolve) => {
			let pending = 2;
			let settled = false;
			const half = (result: Promise<void>): void => {
				result.then(
					() => {
						pending -= 1;
						if (settled || pending > 0) return;
						settled = true;
						resolve();
					},
					(error: unknown) => {
						if (settled) return;
						settled = true;
						void this.fail(error, generation).then(resolve);
					},
				);
			};
			half(this.connect(session, generation));
			half(this.startMic(session, generation));
		});
	}

	private async connect(session: AsrSession, generation: number): Promise<void> {
		await session.connect();
		if (generation !== this.generation) return;
		this.sessionOpen = true;
		this.promote();
	}

	private async startMic(session: AsrSession, generation: number): Promise<void> {
		const open = this.options.openMic ?? openMicrophone;
		const mic = await open({
			...this.options.mic,
			onPcm: (pcm) => {
				this.onPcm(pcm, session, generation);
			},
			onEnded: () => {
				// The device is gone; whatever was said is still worth finishing, and
				// `stop()` is the path that asks the server for it.
				void this.stop();
			},
		});
		if (generation !== this.generation) {
			await mic.stop().catch(() => undefined);
			return;
		}
		this.mic = mic;
	}

	private onPcm(pcm: Int16Array, session: AsrSession, generation: number): void {
		if (generation !== this.generation) return;
		this.setReading(this.meter.push(pcm, this.now()));

		if (!this.micReady) {
			this.micReady = true;
			this.promote();
		}
		// Safe by contract: `push()` drops frames after the session ended instead of
		// throwing out of an audio callback.
		session.push(pcm);
	}

	/**
	 * First audio batch wins the `preparing` → `listening` step; the handshake only
	 * flips `sending` afterwards. Idempotent, so both halves can call it.
	 */
	private promote(): void {
		if (!this.micReady) return;
		this.clearReadyTimer();
		this.setPhase({ kind: "listening", sending: this.sessionOpen });
	}

	private armReadyTimer(generation: number): void {
		const timeoutMs = this.options.preparingTimeoutMs ?? 0;
		if (timeoutMs <= 0) return;
		this.readyTimer = setTimeout(() => {
			this.readyTimer = undefined;
			// `capture`, not `timeout`: a microphone that never delivers is a capture
			// failure the user must act on, while a finish timeout is a soft ending.
			void this.fail(
				new AsrError("capture", `dictation: no audio within ${String(timeoutMs)}ms of opening the microphone`),
				generation,
			);
		}, timeoutMs);
	}

	private clearReadyTimer(): void {
		if (this.readyTimer === undefined) return;
		clearTimeout(this.readyTimer);
		this.readyTimer = undefined;
	}

	// ── events ────────────────────────────────────────────────────────────

	private async drain(session: AsrSession, edit: DictationEdit, generation: number): Promise<void> {
		try {
			for await (const event of session.events) {
				if (generation !== this.generation) return;
				if (event.type === "text") {
					if (event.track === 0) edit.update(event.text);
					if (event.final) {
						await this.ended(generation);
						return;
					}
				} else if (event.type === "closed") {
					await this.ended(generation);
					return;
				}
			}
		} catch {
			// A session that throws out of its iterator is already on its way to
			// `closed`; `finish()` carries the reason into the result.
		}
		await this.ended(generation);
	}

	/**
	 * The session ended without `stop()`: an expiry, a lost connection, or the
	 * server's terminal message. Settle through `finish()` so the transcript and
	 * the reason come from the same object the caller would have received.
	 */
	private async ended(generation: number): Promise<void> {
		if (generation !== this.generation) return;
		if (!this.active) return;
		await this.finishUtterance();
	}

	// ── settling ──────────────────────────────────────────────────────────

	private detach(): {
		session: AsrSession | undefined;
		edit: DictationEdit | undefined;
		mic: Microphone | undefined;
	} {
		const session = this.session;
		const edit = this.edit;
		const mic = this.mic;
		this.session = undefined;
		this.edit = undefined;
		this.mic = undefined;
		this.sessionOpen = false;
		this.micReady = false;
		return { session, edit, mic };
	}

	/**
	 * Settle the utterance once: stop capture, ask the server for the terminal
	 * transcript, and commit or cancel the pre-edit.
	 *
	 * The parts are cleared here rather than up front, because `cancel()` must be
	 * able to reach them while `finish()` is in flight — that is the whole point of
	 * the guarantee above. A cancel, or a new utterance, moves the generation, and
	 * this path then returns before touching the host: the pre-edit was removed by
	 * `cancel()` and the text outcome has nowhere to go.
	 */
	private async finishUtterance(): Promise<DictationResult> {
		if (!this.active) return this.lastResult;
		// Bumped, not just compared: closing the session rejects the handshake that
		// may still be in flight, and that rejection must not turn a user release
		// into a `failed` phase.
		this.generation += 1;
		const generation = this.generation;
		this.active = false;
		this.settling = true;
		this.clearReadyTimer();
		// Read before any await: only an open session can be finished, and a tap
		// shorter than the handshake must be a cancel rather than a `config` error
		// from `finish()`.
		const canFinish = this.sessionOpen;
		const session = this.session;
		const edit = this.edit;
		const mic = this.mic;
		this.sessionOpen = false;
		this.micReady = false;
		this.setPhase({ kind: "committing" });

		try {
			await mic?.stop().catch(() => undefined);

			let finish: FinishOutcome | null = null;
			let error: AsrError | null = null;
			if (session !== undefined && canFinish) {
				try {
					finish = await session.finish();
				} catch (failure) {
					error = toAsrError(failure);
				}
			}
			await session?.close("dictation finished").catch(() => undefined);

			// Cancelled while the terminal message was in flight. The pre-edit is
			// already gone, so this result reaches no document at all.
			if (generation !== this.generation) return EMPTY_RESULT;

			this.session = undefined;
			this.edit = undefined;
			this.mic = undefined;

			const text = finish?.text ?? null;
			if (edit !== undefined) {
				if (text === null || text.length === 0) edit.cancel();
				else edit.commit(text);
			}

			// The pump may have recorded the reason before we asked; a fresh `finish()`
			// outcome wins because it carries the terminal evidence.
			error ??= finish?.error ?? null;

			const result: DictationResult = { text, finish, error };
			this.setPhase(error !== null && isFatalError(error) ? { kind: "failed", error } : { kind: "idle" });
			this.settle(result);
			return result;
		} finally {
			// `cancel()` cleared this itself; the guard only keeps a stale settlement
			// from clearing the flag of an utterance that replaced it.
			if (generation === this.generation) this.settling = false;
		}
	}

	private async fail(error: unknown, generation: number): Promise<void> {
		if (generation !== this.generation) return;
		this.generation += 1;
		this.active = false;
		this.clearReadyTimer();
		const { session, edit, mic } = this.detach();
		edit?.cancel();
		await mic?.stop().catch(() => undefined);
		await session?.close("dictation failed").catch(() => undefined);

		const asr = toAsrError(error);
		this.lastResult = { text: null, finish: null, error: asr };
		this.setPhase(isFatalError(asr) ? { kind: "failed", error: asr } : { kind: "idle" });
		this.settle(this.lastResult);
	}

	/**
	 * Record and announce one utterance's ending. Guarded by the utterance id: the
	 * settle path, a terminal message, and a cancel can race, and a host must see
	 * one result per utterance rather than whichever arrived last.
	 */
	private settle(result: DictationResult): void {
		if (this.utterance === 0 || this.settledUtterance === this.utterance) return;
		this.settledUtterance = this.utterance;
		this.lastResult = result;
		for (const listener of this.settlementListeners) listener(result);
	}

	private setReading(reading: LevelReading): void {
		for (const listener of this.levelListeners) listener(reading);
	}

	private setPhase(phase: DictationPhase): void {
		const previous = this.phaseValue;
		if (samePhase(previous, phase)) return;
		this.phaseValue = phase;
		for (const listener of this.phaseListeners) listener(phase);
	}
}

/**
 * A caret the host can report is not a caret every host `read()` returns: an
 * `EditHost` only promises text. The check is here, at construction, so a
 * missing source is a configuration error rather than a dictation that lands at
 * offset 0.
 */
function caretFromHost(host: EditHost): () => number {
	if (host.read === undefined) {
		throw new AsrError(
			"config",
			"dictation: this host cannot report a caret; pass caret() to say where the sentence starts",
		);
	}
	return () => {
		const reading: unknown = host.read?.();
		if (typeof reading === "object" && reading !== null && "caret" in reading && typeof reading.caret === "number") {
			return reading.caret;
		}
		throw new AsrError("config", "dictation: host.read() reported no caret; pass caret()");
	};
}

/** Every kind is a singleton except `listening`, whose `sending` flag moves. */
function samePhase(previous: DictationPhase, next: DictationPhase): boolean {
	if (previous.kind !== next.kind) return false;
	if (previous.kind === "listening" && next.kind === "listening") {
		return previous.sending === next.sending;
	}
	return true;
}

/** Anything not already classified comes from the capture side of `start()`. */
function toAsrError(error: unknown): AsrError {
	if (error instanceof AsrError) return error;
	if (error instanceof Error) {
		return new AsrError("capture", `dictation: ${error.message}`, { cause: error });
	}
	return new AsrError("capture", `dictation: ${String(error)}`);
}
