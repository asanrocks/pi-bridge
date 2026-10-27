/**
 * One dictation: handshake, audio framing, event pump, finish.
 *
 * The constructor starts nothing: `connect()` is separate so a caller can begin
 * pushing audio the moment the microphone opens, while the token and the socket
 * are still in flight. Audio pushed before the handshake finishes waits in a
 * bounded pre-roll instead of being dropped.
 *
 * Layer 1 only reports. It does not merge text, pick a "best" track, or decide
 * what the UI should show; it does compute the wire-specific `final` flag,
 * because that criterion is protocol knowledge, not presentation policy.
 */
import { resolveAuth, withQuery } from "./auth.ts";
import {
	ASR_APP_KEY,
	ASR_URL,
	IME_USER_AGENT,
	KEEPALIVE_HEADER,
	PROTO_VERSION_HEADER,
	PROTO_VERSION_VALUE,
	SAMPLE_RATE,
} from "./constants.ts";
import { AsrError, codeForStatus, retryableForStatus, ServerStatus } from "./errors.ts";
import { AudioFramer } from "./framer.ts";
import { encodeEnvelope, parseEnvelope } from "./protocol/json.ts";
import type { FrameState } from "./protocol/protobuf.ts";
import { decodeAsrResponse, encodeAsrRequest } from "./protocol/protobuf.ts";
import { parseResults } from "./protocol/results.ts";
import type { Transport, TransportMessage } from "./transport.ts";
import { webSocketTransport } from "./transport.ts";
import type { AsrEvent, AudioCodec, Auth, FrameMs, JsonObject, ServerMessage, Wire } from "./types.ts";

export type SessionPhase = "idle" | "connecting" | "handshaking" | "streaming" | "finishing" | "closed";

export interface AsrSessionOptions {
	wire: Wire;
	auth: Auth;
	/** Injected by tests, relays and extensions; defaults to a runtime `WebSocket`. */
	transport?: Transport;
	/** Defaults to `pcm`, which every runtime and wire path supports. */
	codec?: AudioCodec;
	/**
	 * Defaults follow the measured matrix (`docs/protocol.md` §5.2): 20 ms for
	 * opus, 100 ms for PCM on the JSON wire, and 20 ms for PCM on protobuf, where
	 * only 20 ms blocks have been verified.
	 */
	frameMs?: FrameMs;
	/** Required for `codec: 'opus'`; must encode exactly `frameMs` of 16 kHz mono PCM. */
	encode?: (pcm: Int16Array) => Uint8Array;
	/** Shallow-merged over the verified per-wire defaults; `extra` is merged too. */
	sessionConfig?: JsonObject;
	url?: string;
	/** Silence appended before the finish message. Measured unnecessary; 0 by default. */
	tailMs?: number;
	/** Audio kept from before the handshake finished. Defaults to 500 ms. */
	preRollMs?: number;
	connectTimeoutMs?: number;
	handshakeTimeoutMs?: number;
	/** How long `finish()` waits for the terminal message. */
	finishTimeoutMs?: number;
	/** Emit a `timeout` error when the server goes quiet for this long. 0 disables. */
	idleTimeoutMs?: number;
	/**
	 * Grace period after the server's terminal message, waiting for the final
	 * result it may send immediately afterwards. The two orders are not
	 * guaranteed (docs/protocol.md §6.3); 0 settles on the terminal message.
	 */
	terminalGraceMs?: number;
}

export interface FinishOutcome {
	/** The last session-terminal track-0 text, or null if none arrived. */
	text: string | null;
	/** True when the terminal message never came and the wait timed out. */
	timedOut: boolean;
	/**
	 * True when the server ended the task on its own (it expires after ~20 s
	 * without audio) instead of answering our finish message. The transcript is
	 * then usually null and any later `push()` is dropped.
	 */
	expired: boolean;
	/**
	 * Why the session ended without a clean terminal message, in the same shape as
	 * every other failure: an in-band status failure, an expiry, or the finish
	 * wait timing out. `null` after a clean finish.
	 *
	 * The booleans above are the protocol facts; this is the actionable form, since
	 * it carries `code`, the raw `status` and the `retryable` hint (§7.1), and lets
	 * a caller branch without re-deriving meaning from two flags.
	 */
	error: AsrError | null;
}

export interface SessionStats {
	wire: Wire;
	codec: AudioCodec;
	frameMs: number;
	bytesSent: number;
	framesSent: number;
	samplesPushed: number;
	/** Wall-clock ms of the first `push()`, i.e. when capture actually started. */
	firstPushAt: number | null;
	/**
	 * Wall-clock ms when the handshake completed and `open` was emitted: the
	 * moment audio stops being buffered and starts going out, which together with
	 * `firstPushAt` is the cost a caller cannot see from the outside (§10.7).
	 */
	openedAt: number | null;
	/** Wall-clock ms of the first non-empty result. */
	firstResultAt: number | null;
	finalAt: number | null;
	startedAt: number;
	lastMessageAt: number | null;
}

const TERMINAL_EVENT: Readonly<Record<Wire, string>> = {
	json: "TaskFinished",
	protobuf: "SessionFinished",
};

const FINISH_EVENT: Readonly<Record<Wire, string>> = {
	json: "FinishTask",
	protobuf: "FinishSession",
};

class EventQueue implements AsyncIterable<AsrEvent> {
	private readonly items: AsrEvent[] = [];
	private readonly waiters: ((item: IteratorResult<AsrEvent>) => void)[] = [];
	private done = false;

	push(event: AsrEvent): void {
		if (this.done) return;
		const waiter = this.waiters.shift();
		if (waiter !== undefined) waiter({ value: event, done: false });
		else this.items.push(event);
	}

	end(): void {
		if (this.done) return;
		this.done = true;
		for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
	}

	[Symbol.asyncIterator](): AsyncIterator<AsrEvent> {
		return {
			next: () => {
				const item = this.items.shift();
				if (item !== undefined) return Promise.resolve({ value: item, done: false });
				if (this.done) return Promise.resolve({ value: undefined, done: true });
				return new Promise((resolve) => {
					this.waiters.push(resolve);
				});
			},
		};
	}
}

interface Waiter {
	match: (message: ServerMessage) => boolean;
	resolve: (message: ServerMessage) => void;
	reject: (error: Error) => void;
}

export class AsrSession {
	readonly events: AsyncIterable<AsrEvent>;

	private readonly options: AsrSessionOptions;
	private readonly wire: Wire;
	private readonly codec: AudioCodec;
	private readonly frameMs: FrameMs;
	private readonly taskId = crypto.randomUUID();
	private readonly sessionId = crypto.randomUUID();
	private readonly requestId = crypto.randomUUID();
	private readonly queue = new EventQueue();
	private readonly preRoll: Int16Array[] = [];
	private readonly stats: SessionStats;

	private transport: Transport | undefined;
	private framer: AudioFramer | undefined;
	private creds: { token: string; query: Readonly<Record<string, string>> } | undefined;
	private phase: SessionPhase = "idle";
	private waiter: Waiter | undefined;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private finishPromise: Promise<FinishOutcome> | undefined;
	private settleFinish: ((outcome: FinishOutcome) => void) | undefined;
	private finalText: string | null = null;
	/** The failure that ended the session, if one did; reported by `finish()`. */
	private failure: AsrError | undefined;
	private serverFinished = false;
	private preRollSamples = 0;
	private closedEmitted = false;
	/** Set once the finish message goes out, which separates a reply from expiry. */
	private finishRequested = false;
	private expired = false;
	private terminalGraceTimer: ReturnType<typeof setTimeout> | undefined;
	private audioAfterEndReported = false;
	/**
	 * Events produced by the handshake acknowledgements. They arrive before the
	 * session is usable, but `open` is what tells a caller it may send, so it is
	 * emitted first and these follow it in arrival order.
	 */
	private deferred: AsrEvent[] | undefined = [];

	constructor(options: AsrSessionOptions) {
		this.options = options;
		this.wire = options.wire;
		this.codec = options.codec ?? "pcm";
		this.frameMs = options.frameMs ?? defaultFrameMs(this.wire, this.codec);
		this.events = this.queue;
		this.stats = {
			wire: this.wire,
			codec: this.codec,
			frameMs: this.frameMs,
			bytesSent: 0,
			framesSent: 0,
			samplesPushed: 0,
			firstPushAt: null,
			openedAt: null,
			firstResultAt: null,
			finalAt: null,
			startedAt: Date.now(),
			lastMessageAt: null,
		};
	}

	/** Handshake-complete convenience for callers that push only after connecting. */
	static async start(options: AsrSessionOptions): Promise<AsrSession> {
		const session = new AsrSession(options);
		await session.connect();
		return session;
	}

	get state(): SessionPhase {
		return this.phase;
	}

	/** The last session-terminal track-0 text the server sent, if any. */
	get transcript(): string | null {
		return this.finalText;
	}

	get snapshot(): Readonly<SessionStats> {
		return { ...this.stats };
	}

	async connect(): Promise<void> {
		if (this.phase !== "idle") throw new AsrError("config", "session: connect() called twice");
		this.phase = "connecting";

		try {
			const transport = this.options.transport ?? webSocketTransport({ headers: this.wire === "protobuf" });
			this.transport = transport;
			if (this.wire === "protobuf" && !transport.capabilities.headers) {
				throw new AsrError(
					"unsupported",
					"session: the protobuf wire needs the proto-version header, which this transport cannot set",
				);
			}
			this.assertAuthShape();

			// Inside the try on purpose: a failing `getToken()` is the most likely
			// auth failure, and it has to end the session like any other failed start.
			const creds = await resolveAuth(this.options.auth);
			this.creds = creds;

			const url = withQuery(this.options.url ?? ASR_URL, creds.query);
			const headers: Record<string, string> =
				this.wire === "protobuf"
					? {
							[PROTO_VERSION_HEADER]: PROTO_VERSION_VALUE,
							[KEEPALIVE_HEADER]: "true",
							"User-Agent": IME_USER_AGENT,
						}
					: {};

			await this.withTimeout(transport.connect(url, headers), this.options.connectTimeoutMs ?? 5000, "connect");
			void this.pump();

			this.phase = "handshaking";
			this.framer = new AudioFramer({
				wire: this.wire,
				codec: this.codec,
				frameMs: this.frameMs,
				sampleRate: SAMPLE_RATE,
				tailMs: this.options.tailMs ?? 0,
				...(this.options.encode === undefined ? {} : { encode: this.options.encode }),
				sink: (data, state) => {
					this.sendAudioFrame(data, state);
				},
			});

			// The two wires do not just name their methods differently: protobuf has a
			// separate StartSession round trip, JSON starts streaming right after ack.
			if (this.wire === "protobuf") {
				this.sendMethod("StartTask");
				this.assertOk(await this.awaitMessage("start task", ["TaskStarted"]));
				this.sendMethod("StartSession", JSON.stringify(this.sessionConfig()));
				this.assertOk(await this.awaitMessage("start session", ["SessionStarted"]));
			} else {
				this.sendEnvelope("StartTask", JSON.stringify(this.sessionConfig()));
				this.assertOk(await this.awaitMessage("start task", ["TaskStarted"]));
			}

			this.phase = "streaming";
			this.flushPreRoll();
			this.armIdle();
			this.flushDeferred();
		} catch (error) {
			this.failStart(error);
			throw error;
		}
	}

	/**
	 * Feed 16 kHz mono PCM. Accepted until the session ends; audio that arrives
	 * before streaming starts waits in a bounded pre-roll, and audio that arrives
	 * after the end is dropped with one error event.
	 *
	 * Dropping instead of throwing is deliberate: this is called from an audio
	 * callback, where an exception either kills the capture pipeline or gets
	 * swallowed. The server expires a task after ~20 s without audio, so a late
	 * push is a normal race, not a programming error.
	 */
	push(input: Int16Array | Uint8Array): void {
		// `serverFinished` covers the window between the terminal message and the
		// socket closing, which is where an expired task lands.
		if (this.serverFinished || this.phase === "closed" || this.phase === "finishing") {
			this.reportAudioAfterEnd();
			return;
		}
		const samples = toSamples(input);
		if (samples.length === 0) return;
		this.stats.samplesPushed += samples.length;
		this.stats.firstPushAt ??= Date.now();

		// Not just `framer === undefined`: on the protobuf wire the server has not
		// acknowledged StartSession yet, and a TaskRequest before that breaks the
		// documented two-round handshake.
		if (this.framer === undefined || this.phase !== "streaming") {
			this.preRoll.push(samples);
			this.preRollSamples += samples.length;
			const budget = Math.max(0, Math.round(((this.options.preRollMs ?? 500) * SAMPLE_RATE) / 1000));
			while (this.preRollSamples > budget && this.preRoll.length > 0) {
				const dropped = this.preRoll.shift();
				if (dropped !== undefined) this.preRollSamples -= dropped.length;
			}
			return;
		}
		this.framer.push(samples);
	}

	/** Send the finish message and wait for the server's terminal message. */
	finish(): Promise<FinishOutcome> {
		this.finishPromise ??= this.runFinish();
		return this.finishPromise;
	}

	async close(reason = "client closed"): Promise<void> {
		if (this.phase === "closed") return;
		this.phase = "closed";
		this.clearIdle();
		this.clearTerminalGrace();
		this.rejectWaiter(new AsrError("aborted", `session: ${reason}`));
		this.settle(this.outcome(false));
		if (!this.closedEmitted) {
			this.closedEmitted = true;
			this.queue.push({ type: "closed", reason });
			this.queue.end();
		}
		await this.transport?.close();
	}

	// ── finish ────────────────────────────────────────────────────────────

	private async runFinish(): Promise<FinishOutcome> {
		if (this.phase === "closed") return this.outcome(false);
		if (this.phase !== "streaming") {
			throw new AsrError("config", `session: finish() during ${this.phase}`);
		}
		this.phase = "finishing";
		this.clearIdle();
		// Only flush if the task is still alive: after an expiry the socket is gone
		// or the task is over, and emitting a `last` frame would throw from here.
		if (!this.serverFinished) {
			try {
				this.framer?.finish();
				this.finishRequested = true;
				// Each wire names the close differently *and* carries it differently:
				// JSON wraps it in an envelope, protobuf in an AsrRequest.
				if (this.wire === "protobuf") this.sendMethod(FINISH_EVENT.protobuf);
				else this.sendEnvelope(FINISH_EVENT.json);
			} catch (error) {
				// The socket died while closing. Close cleanly so the event iterator
				// still ends, then surface the real reason instead of hanging in
				// `finishing` forever.
				await this.close("finish could not be sent");
				throw error instanceof Error ? error : new AsrError("connection", String(error));
			}
		}

		if (this.serverFinished) return this.outcome(false);

		return new Promise<FinishOutcome>((resolve) => {
			this.settleFinish = resolve;
			const timeoutMs = this.options.finishTimeoutMs ?? 8000;
			const timer = setTimeout(() => {
				// Settle *and* end the session. Leaving it in `finishing` would strand
				// the event iterator: the idle watchdog was cleared and nothing else
				// would ever emit `closed`.
				this.failure ??= new AsrError(
					"timeout",
					`session: no terminal message within ${String(timeoutMs)}ms of the finish request`,
				);
				this.settle(this.outcome(true));
				void this.close("finish timeout");
			}, timeoutMs);
			unref(timer);
		});
	}

	private settle(outcome: FinishOutcome): void {
		const resolve = this.settleFinish;
		this.settleFinish = undefined;
		resolve?.(outcome);
	}

	private outcome(timedOut: boolean): FinishOutcome {
		return { text: this.finalText, timedOut, expired: this.expired, error: this.failure ?? null };
	}

	/**
	 * The terminal message can arrive before the final result it refers to (the
	 * protocol does not order them). Wait briefly so a later results message is
	 * still reflected in the outcome.
	 */
	private armTerminalGrace(): void {
		this.clearTerminalGrace();
		const graceMs = this.options.terminalGraceMs ?? 250;
		if (graceMs <= 0) {
			this.settleTerminal();
			return;
		}
		const timer = setTimeout(() => {
			this.terminalGraceTimer = undefined;
			this.settleTerminal();
		}, graceMs);
		unref(timer);
		this.terminalGraceTimer = timer;
	}

	private settleTerminal(): void {
		this.clearTerminalGrace();
		this.settle(this.outcome(false));
	}

	private clearTerminalGrace(): void {
		if (this.terminalGraceTimer !== undefined) {
			clearTimeout(this.terminalGraceTimer);
			this.terminalGraceTimer = undefined;
		}
	}

	private reportAudioAfterEnd(): void {
		if (this.audioAfterEndReported) return;
		this.audioAfterEndReported = true;
		const code = this.expired ? "expired" : "aborted";
		this.emitError(new AsrError(code, `session: audio pushed while ${this.phase}; the frame was dropped`));
	}

	/**
	 * A SAMI token is rejected on the protobuf wire (`SessionFailed 40200001`,
	 * "session auth, userID or appID is empty"); only the app key plus a
	 * registered device id authenticates there. See docs/protocol.md §1.2.
	 */
	private assertAuthShape(): void {
		if (this.wire !== "protobuf") return;
		if ("device" in this.options.auth) return;
		throw new AsrError(
			"config",
			"session: the protobuf wire rejects a SAMI token; pass auth: { device } (docs/protocol.md §1.2)",
		);
	}

	// ── pump ──────────────────────────────────────────────────────────────

	private async pump(): Promise<void> {
		const transport = this.transport;
		if (transport === undefined) return;
		for (;;) {
			let received: TransportMessage | null;
			try {
				received = await transport.receive();
			} catch (error) {
				this.emitError(new AsrError("connection", "session: receive failed", { cause: error }));
				break;
			}
			if (received === null) break;
			try {
				this.dispatch(received.data);
			} catch (error) {
				this.emitError(error instanceof Error ? error : new AsrError("protocol", String(error)));
			}
		}
		this.onTransportClosed();
	}

	private dispatch(raw: string | Uint8Array): void {
		const message = this.decode(raw);
		this.stats.lastMessageAt = Date.now();
		this.armIdle();

		this.enqueue({ type: "message", message });

		if (message.payloadText.length > 0) {
			const parsed = parseResults(message.payloadText);
			if (parsed !== null) {
				this.enqueue(
					parsed.heartbeat
						? { type: "heartbeat" }
						: {
								type: "results",
								tracks: parsed.tracks,
								vadStart: parsed.vadStart,
								extra: parsed.extra,
							},
				);
				for (const track of parsed.tracks) {
					const final = this.isFinalTrack(track.track, track.interim, track.vadFinished);
					this.enqueue({
						type: "text",
						track: track.track,
						text: track.text,
						interim: track.interim,
						vadFinished: track.vadFinished,
						nonstream: track.nonstream,
						final,
					});
					if (track.text.length > 0) {
						this.stats.firstResultAt ??= Date.now();
						if (final) {
							this.finalText = track.text;
							this.stats.finalAt = Date.now();
							// The terminal message can precede this one; settle as soon as the
							// text it was waiting for has arrived.
							if (this.serverFinished) this.settleTerminal();
						}
					}
				}
			}
		}

		let reported: AsrError | undefined;
		if (message.status !== 0 && message.status !== ServerStatus.ok) {
			reported = new AsrError(
				codeForStatus(message.status),
				`session: ${message.type || "server"} (${String(message.status)}): ${message.statusMessage}`,
				{ status: message.status, retryable: retryableForStatus(message.status) },
			);
			this.emitError(reported);
		}

		if (message.type === TERMINAL_EVENT[this.wire]) {
			this.serverFinished = true;
			// A terminal message we did not ask for means the task expired (the
			// server ends it after ~20 s without audio) or was cancelled elsewhere.
			if (!this.finishRequested) {
				this.expired = true;
				// Recorded for `finish()` only: expiry is a documented normal outcome
				// (§5.6), not a failure event, so it is not emitted here.
				this.failure ??= new AsrError(
					"expired",
					"session: the server ended the task without a finish request (it expires after ~20 s without audio)",
				);
			}
			if (this.finalText !== null) this.settleTerminal();
			else this.armTerminalGrace();
		} else if (message.type.endsWith("Failed")) {
			// A failure is terminal for the session too; without this, finish() would
			// sit until its timeout even though nothing else is coming. Nothing more
			// will arrive, so there is no reason to wait out the grace period.
			this.serverFinished = true;
			this.clearTerminalGrace();
			this.failure ??= reported ?? new AsrError("server", `session: ${message.type}`);
			this.settle(this.outcome(false));
		}

		const waiter = this.waiter;
		if (waiter !== undefined && (waiter.match(message) || message.type.endsWith("Failed"))) {
			this.waiter = undefined;
			waiter.resolve(message);
		}

		// A `*Failed` message is terminal for the session (§4.5, §7.2): a mid-session
		// rejection can only be wound down, and the protocol does not promise a socket
		// close, so nothing else would ever end the event stream. During the handshake
		// `connect()` already fails and ends it, and doing it here would reorder the
		// events it defers until `open`.
		if (message.type.endsWith("Failed") && this.phase !== "connecting" && this.phase !== "handshaking") {
			void this.close(`server failed: ${message.type}`);
		}
	}

	/** Wire-specific terminal criterion (`docs/protocol.md` §6.3). */
	private isFinalTrack(track: number, interim: boolean, vadFinished: boolean): boolean {
		if (track !== 0 || interim) return false;
		return this.wire === "protobuf" ? vadFinished : true;
	}

	private decode(raw: string | Uint8Array): ServerMessage {
		if (this.wire === "protobuf") {
			if (typeof raw === "string") {
				throw new AsrError(
					"protocol",
					"session: expected binary frames — the server ignored the proto-version header",
				);
			}
			const response = decodeAsrResponse(raw);
			return {
				wire: "protobuf",
				type: response.messageType,
				status: response.statusCode,
				statusMessage: response.statusMessage,
				payloadText: response.resultJson,
				raw,
			};
		}
		if (typeof raw !== "string") {
			throw new AsrError("protocol", "session: expected text frames — the server switched to protobuf");
		}
		const envelope = parseEnvelope(raw);
		return {
			wire: "json",
			type: envelope.event,
			status: envelope.statusCode,
			statusMessage: envelope.statusText,
			payloadText: envelope.payload,
			raw,
		};
	}

	private onTransportClosed(): void {
		this.clearIdle();
		this.clearTerminalGrace();
		this.rejectWaiter(new AsrError("connection", "session: the connection closed during the handshake"));
		this.settle(this.outcome(false));
		if (!this.closedEmitted) {
			this.closedEmitted = true;
			this.queue.push(this.serverFinished ? { type: "closed" } : { type: "closed", reason: "connection lost" });
			this.queue.end();
		}
		if (this.phase !== "closed") this.phase = "closed";
	}

	// ── sending ───────────────────────────────────────────────────────────

	private sendMethod(method: string, payload?: string): void {
		const request: Parameters<typeof encodeAsrRequest>[0] = {
			token: this.requireCreds().token,
			methodName: method,
			requestId: this.requestId,
		};
		if (payload !== undefined) request.payload = payload;
		this.sendBytes(encodeAsrRequest(request));
	}

	private sendEnvelope(event: string, payload?: string): void {
		const envelope: Parameters<typeof encodeEnvelope>[0] = {
			task_id: this.taskId,
			session_id: this.sessionId,
			namespace: "ASR",
			event,
			appkey: ASR_APP_KEY,
			token: this.requireCreds().token,
		};
		if (payload !== undefined) envelope.payload = payload;
		this.sendBytes(encodeEnvelope(envelope));
	}

	private sendAudioFrame(data: Uint8Array, state: FrameState | undefined): void {
		if (this.wire === "json") {
			// Bare binary frame: the JSON envelope has no per-frame overhead (§5.3).
			this.sendBytes(data);
		} else {
			const request: Parameters<typeof encodeAsrRequest>[0] = {
				methodName: "TaskRequest",
				requestId: this.requestId,
				audio: data,
				payload: JSON.stringify({ extra: {}, timestamp_ms: Date.now() }),
			};
			if (state !== undefined) request.frameState = state;
			this.sendBytes(encodeAsrRequest(request));
		}
		this.stats.framesSent += 1;
	}

	private sendBytes(data: Uint8Array | string): void {
		const transport = this.transport;
		if (transport === undefined) throw new AsrError("connection", "session: not connected");
		transport.send(data);
		this.stats.bytesSent += typeof data === "string" ? data.length : data.byteLength;
	}

	// ── helpers ───────────────────────────────────────────────────────────

	private flushPreRoll(): void {
		const chunks = this.preRoll.splice(0);
		this.preRollSamples = 0;
		for (const chunk of chunks) this.framer?.push(chunk);
	}

	private sessionConfig(): JsonObject {
		const deviceId = this.creds?.query.device_id;
		const overrides = this.options.sessionConfig ?? {};
		const format = this.codec === "opus" ? "speech_opus" : "raw_pcm";

		// The two wires do not share a schema; normalising them would be a bug (§4.3).
		if (this.wire === "protobuf") {
			return mergeConfig(
				{
					audio_info: { channel: 1, format, sample_rate: SAMPLE_RATE },
					enable_punctuation: true,
					enable_speech_rejection: false,
					extra: {
						app_name: "com.android.chrome",
						cell_compress_rate: 8,
						enable_asr_threepass: true,
						enable_asr_twopass: true,
						input_mode: "tool",
						...(deviceId === undefined ? {} : { did: deviceId }),
					},
				},
				overrides,
			);
		}

		return mergeConfig(
			{
				app_name: "DoubaoIme",
				app_version: "1.0.0.207",
				enable_asr_twopass: true,
				enable_asr_threepass: true,
				strong_ddc: true,
				remove_space_between_han_num: true,
				remove_space_between_han_eng: true,
				enable_asr_format: true,
				audio_format: format,
				audio_info: { channel: 1, format, sample_rate: SAMPLE_RATE },
			},
			overrides,
		);
	}

	private get handshakeTimeoutMs(): number {
		return this.options.handshakeTimeoutMs ?? 5000;
	}

	private awaitMessage(label: string, types: readonly string[]): Promise<ServerMessage> {
		if (this.phase === "closed") {
			return Promise.reject(new AsrError("connection", `session: closed before ${label}`));
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.waiter === undefined) return;
				this.waiter = undefined;
				reject(
					new AsrError(
						"timeout",
						`session: no ${types.join("/")} within ${String(this.handshakeTimeoutMs)}ms while expecting ${label}`,
					),
				);
			}, this.handshakeTimeoutMs);
			unref(timer);
			this.waiter = {
				match: (message) => types.includes(message.type),
				resolve: (message) => {
					clearTimeout(timer);
					resolve(message);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			};
		});
	}

	private assertOk(message: ServerMessage): void {
		if (message.status === 0 || message.status === ServerStatus.ok) return;
		throw new AsrError(
			codeForStatus(message.status),
			`session: ${message.type} failed (${String(message.status)}): ${message.statusMessage}`,
			{ status: message.status, retryable: retryableForStatus(message.status) },
		);
	}

	private rejectWaiter(error: Error): void {
		const waiter = this.waiter;
		this.waiter = undefined;
		waiter?.reject(error);
	}

	private enqueue(event: AsrEvent): void {
		if (this.deferred === undefined) this.queue.push(event);
		else this.deferred.push(event);
	}

	private emitError(error: Error): void {
		this.enqueue({ type: "error", error });
	}

	/** Publish `open` first, then whatever the handshake already produced. */
	private flushDeferred(): void {
		const pending = this.deferred ?? [];
		this.deferred = undefined;
		// Stamped before `open` is published, so a listener that reacts to it reads
		// a complete snapshot.
		this.stats.openedAt = Date.now();
		this.queue.push({ type: "open", wire: this.wire, codec: this.codec });
		for (const event of pending) this.queue.push(event);
	}

	private releaseDeferred(): void {
		const pending = this.deferred ?? [];
		this.deferred = undefined;
		for (const event of pending) this.queue.push(event);
	}

	private failStart(error: unknown): void {
		this.clearIdle();
		this.clearTerminalGrace();
		this.phase = "closed";
		this.releaseDeferred();
		// An in-band status failure was already reported by dispatch(); the copy that
		// aborts connect() is the same event, so it must not be emitted twice.
		if (!(error instanceof AsrError && error.status !== undefined)) {
			this.emitError(error instanceof Error ? error : new AsrError("protocol", String(error)));
		}
		if (!this.closedEmitted) {
			this.closedEmitted = true;
			this.queue.push({ type: "closed", reason: "connect failed" });
			this.queue.end();
		}
		void this.transport?.close();
	}

	private armIdle(): void {
		this.clearIdle();
		const idleMs = this.options.idleTimeoutMs ?? 15_000;
		if (idleMs <= 0 || this.phase === "closed") return;
		const timer = setTimeout(() => {
			this.releaseDeferred();
			const error = new AsrError("timeout", `session: no server message for ${String(idleMs)}ms`);
			this.failure ??= error;
			this.emitError(error);
			void this.close("idle timeout");
		}, idleMs);
		unref(timer);
		this.idleTimer = timer;
	}

	private clearIdle(): void {
		if (this.idleTimer !== undefined) {
			clearTimeout(this.idleTimer);
			this.idleTimer = undefined;
		}
	}

	private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new AsrError("timeout", `session: ${label} timed out after ${String(ms)}ms`));
			}, ms);
			unref(timer);
			promise.then(
				(value) => {
					clearTimeout(timer);
					resolve(value);
				},
				(error: unknown) => {
					clearTimeout(timer);
					reject(error instanceof Error ? error : new AsrError("connection", String(error)));
				},
			);
		});
	}

	private requireCreds(): { token: string; query: Readonly<Record<string, string>> } {
		const creds = this.creds;
		if (creds === undefined) throw new AsrError("config", "session: credentials not resolved");
		return creds;
	}
}

/**
 * The frame length each wire has actually been measured with (`docs/protocol.md`
 * §5.2). A caller who knows better can override it; defaulting to an unverified
 * combination is how a protocol assumption turns into a mystery timeout.
 */
function defaultFrameMs(wire: Wire, codec: AudioCodec): FrameMs {
	if (codec === "opus") return 20;
	return wire === "protobuf" ? 20 : 100;
}

function mergeConfig(defaults: JsonObject, overrides: JsonObject): JsonObject {
	const merged: JsonObject = { ...defaults, ...overrides };
	if (isPlainObject(defaults.extra) && isPlainObject(overrides.extra)) {
		merged.extra = { ...defaults.extra, ...overrides.extra };
	}
	return merged;
}

function isPlainObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toSamples(input: Int16Array | Uint8Array): Int16Array {
	if (input instanceof Int16Array) return input;
	if (input.byteLength % 2 !== 0) {
		throw new AsrError("config", "session: PCM byte length must be a multiple of 2");
	}
	const copy = new Uint8Array(input.byteLength);
	copy.set(input);
	return new Int16Array(copy.buffer);
}

/** Node timers keep the event loop alive; a dictation must not pin the process. */
function unref(timer: unknown): void {
	if (typeof timer === "object" && timer !== null && "unref" in timer) {
		(timer as { unref: () => void }).unref();
	}
}
