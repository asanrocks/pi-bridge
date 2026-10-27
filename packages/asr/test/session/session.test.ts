import { describe, expect, it } from "vitest";
import { AsrError } from "../../src/errors.ts";
import type { AsrSessionOptions } from "../../src/session.ts";
import { AsrSession } from "../../src/session.ts";
import {
	decodeRequest,
	jsonMessage,
	MockTransport,
	protoResponse,
	ramp,
	resultPayload,
	sleep,
	tick,
} from "../../src/testing/mock-transport.ts";
import type { AsrEvent, Auth } from "../../src/types.ts";

interface Harness {
	transport: MockTransport;
	session: AsrSession;
	events: AsrEvent[];
	drained: Promise<void>;
}

function harness(options: Omit<AsrSessionOptions, "transport" | "auth"> & { headers?: boolean; auth?: Auth }): Harness {
	const { headers, auth, ...rest } = options;
	const transport = new MockTransport(headers === undefined ? {} : { headers });
	// The protobuf wire rejects a SAMI token (docs/protocol.md §1.2), so the
	// default credential follows the wire.
	const fallback: Auth = rest.wire === "protobuf" ? { device: { deviceId: "4242" } } : { token: "token" };
	const session = new AsrSession({ auth: auth ?? fallback, ...rest, transport });
	const events: AsrEvent[] = [];
	const drained = (async () => {
		for await (const event of session.events) events.push(event);
	})();
	return { transport, session, events, drained };
}

/** Drive the JSON handshake to completion. */
async function openJson(h: Harness): Promise<void> {
	const connecting = h.session.connect();
	await tick();
	h.transport.push(jsonMessage({ event: "TaskStarted" }));
	await connecting;
}

/** Drive the protobuf two-round handshake to completion. */
async function openProtobuf(h: Harness): Promise<void> {
	const connecting = h.session.connect();
	await tick();
	h.transport.push(protoResponse({ type: "TaskStarted" }));
	await tick();
	h.transport.push(protoResponse({ type: "SessionStarted" }));
	await connecting;
}

describe("AsrSession / JSON wire", () => {
	it("sends StartTask with the verified defaults, streams binary frames, and finishes", async () => {
		const h = harness({ wire: "json" });
		await openJson(h);

		const payload = JSON.parse(h.transport.textFrames[0] ?? "{}") as {
			event: string;
			token: string;
			appkey: string;
			payload: string;
		};
		expect(payload.event).toBe("StartTask");
		expect(payload.token).toBe("token");
		expect(payload.appkey).toBe("OrnqKvSSrs");
		const config = JSON.parse(payload.payload) as Record<string, unknown>;
		expect(config).toMatchObject({
			app_name: "DoubaoIme",
			audio_format: "raw_pcm",
			enable_asr_twopass: true,
			enable_asr_threepass: true,
		});
		expect(config.audio_info).toEqual({ channel: 1, format: "raw_pcm", sample_rate: 16_000 });

		h.session.push(ramp(1600));
		expect(h.transport.binaryFrames).toHaveLength(1);
		expect(h.transport.binaryFrames[0]).toHaveLength(3200);
		expect(h.transport.binaryFrames[0]?.slice(0, 4)).toEqual(new Uint8Array([0, 0, 1, 0]));

		const finishing = h.session.finish();
		await tick();
		h.transport.push(jsonMessage({ payload: resultPayload([{ text: "你好。", is_interim: false }]) }));
		h.transport.push(jsonMessage({ event: "TaskFinished" }));
		const outcome = await finishing;

		expect(outcome).toEqual({ text: "你好。", timedOut: false, expired: false, error: null });
		expect(h.session.transcript).toBe("你好。");
		expect(h.transport.textFrames.map((frame) => envelopeOf(frame).event)).toEqual(["StartTask", "FinishTask"]);
		// Closing the JSON wire is a pure flush: the stream above ended on a frame
		// boundary, so nothing is pending and no silent frame is synthesised
		// (`docs/protocol.md` §5.5). Only the finish message follows the audio.
		expect(h.transport.binaryFrames).toHaveLength(1);

		await h.session.close();
		await h.drained;
		expect(h.events[0]).toEqual({ type: "open", wire: "json", codec: "pcm" });
		expect(h.events.at(-1)?.type).toBe("closed");
	});

	it("records when the session became ready", async () => {
		const h = harness({ wire: "json" });
		expect(h.session.snapshot.openedAt).toBeNull();

		await openJson(h);
		const stats = h.session.snapshot;
		expect(stats.openedAt).not.toBeNull();
		expect(stats.openedAt ?? 0).toBeGreaterThanOrEqual(stats.startedAt);

		await h.session.close();
		await h.drained;
	});

	it("reports one event per message, with results and per-track text", async () => {
		const h = harness({ wire: "json" });
		await openJson(h);

		h.transport.push(
			jsonMessage({
				payload: resultPayload(
					[
						{ text: "你好，", is_interim: true },
						{ text: "你好", is_interim: false, extra: { seq_id: 4 } },
					],
					{ vad_start: false },
				),
			}),
		);
		await tick();

		const results = h.events.find((event) => event.type === "results");
		expect(results?.type === "results" && results.tracks).toHaveLength(2);
		const texts = h.events.filter((event) => event.type === "text");
		expect(texts).toEqual([
			{
				type: "text",
				track: 0,
				text: "你好，",
				interim: true,
				vadFinished: false,
				nonstream: false,
				final: false,
			},
			{
				type: "text",
				track: 1,
				text: "你好",
				interim: false,
				vadFinished: false,
				nonstream: false,
				final: false,
			},
		]);
		// A non-terminal track can say is_interim:false and must not become the transcript.
		expect(h.session.transcript).toBeNull();

		await h.session.close();
		await h.drained;
	});

	it("surfaces the keepalive as a heartbeat event", async () => {
		const h = harness({ wire: "json" });
		await openJson(h);

		h.transport.push(jsonMessage({ payload: resultPayload(null, { heartbeat_num: 2 }) }));
		await tick();
		expect(h.events.some((event) => event.type === "heartbeat")).toBe(true);

		await h.session.close();
		await h.drained;
	});

	it("rejects the handshake on an auth failure and reports the status code", async () => {
		const h = harness({ wire: "json" });
		const connecting = h.session.connect();
		await tick();
		h.transport.push(jsonMessage({ event: "TaskFailed", status: 40_200_001, statusText: "IllegalToken" }));

		await expect(connecting).rejects.toBeInstanceOf(AsrError);
		await expect(connecting).rejects.toMatchObject({
			code: "auth_expired",
			status: 40_200_001,
			// Minting a new token and reconnecting is the documented remedy (§7.2),
			// so the caller can retry instead of surfacing a fatal error.
			retryable: true,
		});

		await h.drained;
		const error = h.events.find((event) => event.type === "error");
		expect(error?.type === "error" && (error.error as AsrError).status).toBe(40_200_001);
		expect(h.events.at(-1)?.type).toBe("closed");
		expect(h.session.state).toBe("closed");
	});

	it("times out when the server never acknowledges the handshake", async () => {
		const h = harness({ wire: "json", handshakeTimeoutMs: 20 });
		await expect(h.session.connect()).rejects.toMatchObject({ code: "timeout" });
		await h.drained;
	});

	it("times out the finish wait, keeps the text, and ends the session", async () => {
		const h = harness({ wire: "json", finishTimeoutMs: 20 });
		await openJson(h);
		h.transport.push(jsonMessage({ payload: resultPayload([{ text: "早。", is_interim: false }]) }));
		await tick();

		const outcome = await h.session.finish();
		// Settling alone used to strand the iterator: no `closed`, no transport close.
		expect(outcome).toMatchObject({ text: "早。", timedOut: true, expired: false });
		// The boolean says what happened; the error says whether to retry (§7.1).
		expect(outcome.error).toMatchObject({ code: "timeout", retryable: true });
		await h.drained;
		expect(h.events.at(-1)).toEqual({ type: "closed", reason: "finish timeout" });
		expect(h.session.state).toBe("closed");
	});

	it("reports an idle connection and closes it", async () => {
		const h = harness({ wire: "json", idleTimeoutMs: 20 });
		await openJson(h);
		await sleep(60);
		expect(h.session.state).toBe("closed");
		const error = h.events.find((event) => event.type === "error");
		expect(error?.type === "error" && (error.error as AsrError).code).toBe("timeout");
		await h.drained;
	});

	it("drops audio pushed after finishing starts, with one error event", async () => {
		const h = harness({ wire: "json", finishTimeoutMs: 10 });
		await openJson(h);
		const finishing = h.session.finish();
		const before = h.transport.binaryFrames.length;
		// Audio callbacks cannot handle exceptions: drop the frame and report once.
		expect(() => {
			h.session.push(ramp(320));
			h.session.push(ramp(320));
		}).not.toThrow();
		expect(h.transport.binaryFrames).toHaveLength(before);

		await finishing;
		const errors = h.events.filter((event) => event.type === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0]?.type === "error" && (errors[0].error as AsrError).code).toBe("aborted");

		await h.session.close();
		await h.drained;
	});
});

describe("AsrSession / protobuf wire", () => {
	it("runs the two-round handshake with the required headers and query", async () => {
		const h = harness({ wire: "protobuf", auth: { device: { deviceId: "4242" } } });
		const connecting = h.session.connect();
		await tick();

		expect(h.transport.connectArgs?.url).toContain("aid=401734");
		expect(h.transport.connectArgs?.url).toContain("device_id=4242");
		expect(h.transport.connectArgs?.headers).toMatchObject({ "proto-version": "v2" });

		const startTask = decodeRequest(h.transport.binaryFrames[0]!);
		expect(startTask).toMatchObject({ methodName: "StartTask", serviceName: "ASR" });

		h.transport.push(protoResponse({ type: "TaskStarted" }));
		await tick();

		const startSession = decodeRequest(h.transport.binaryFrames[1]!);
		expect(startSession.methodName).toBe("StartSession");
		expect(JSON.parse(startSession.payload ?? "{}")).toMatchObject({
			audio_info: { channel: 1, format: "raw_pcm", sample_rate: 16_000 },
			enable_punctuation: true,
			extra: { did: "4242", enable_asr_twopass: true, input_mode: "tool" },
		});

		h.transport.push(protoResponse({ type: "SessionStarted" }));
		await connecting;

		await h.session.close();
		await h.drained;
	});

	it("marks the first, middle and last audio frames", async () => {
		const h = harness({ wire: "protobuf", frameMs: 20 });
		await openProtobuf(h);

		h.session.push(ramp(960));
		const requests = h.transport.binaryFrames.map((frame) => decodeRequest(frame));
		const audio = requests.filter((request) => request.methodName === "TaskRequest");
		expect(audio.map((request) => request.frameState)).toEqual([1, 3, 3]);

		const finishing = h.session.finish();
		await tick();
		h.transport.push(protoResponse({ type: "SessionFinished" }));
		await finishing;

		const afterFinish = h.transport.binaryFrames.map((frame) => decodeRequest(frame));
		expect(afterFinish.at(-2)).toMatchObject({ methodName: "TaskRequest", frameState: 9 });
		expect(afterFinish.at(-1)?.methodName).toBe("FinishSession");

		await h.session.close();
		await h.drained;
	});

	it("buffers audio pushed before the handshake and flushes it in order", async () => {
		const h = harness({ wire: "protobuf", frameMs: 20 });
		const first = ramp(320, 0);
		const second = ramp(320, 1000);
		h.session.push(first);
		h.session.push(second);
		expect(h.transport.sent).toEqual([]);

		await openProtobuf(h);
		const audio = h.transport.binaryFrames
			.map((frame) => decodeRequest(frame))
			.filter((request) => request.methodName === "TaskRequest");
		expect(audio).toHaveLength(2);
		expect(pcmOf(audio[0]!.audio!)).toEqual(Array.from(first));
		expect(pcmOf(audio[1]!.audio!)).toEqual(Array.from(second));
		await h.session.close();
		await h.drained;
	});

	it("pads a short utterance and closes with a silent last frame", async () => {
		const h = harness({ wire: "protobuf", frameMs: 20 });
		await openProtobuf(h);

		h.session.push(ramp(100));
		const finishing = h.session.finish();
		await tick();
		h.transport.push(protoResponse({ type: "SessionFinished" }));
		await finishing;

		const audio = h.transport.binaryFrames
			.map((frame) => decodeRequest(frame))
			.filter((request) => request.methodName === "TaskRequest");
		expect(audio).toHaveLength(2);
		expect(audio[0]?.frameState).toBe(1);
		const samples = audio[0]!.audio!;
		expect(Array.from(new Int16Array(samples.buffer, samples.byteOffset, 3))).toEqual([0, 1, 2]);
		expect(new Int16Array(samples.buffer, samples.byteOffset + 200).every((v) => v === 0)).toBe(true);
		expect(audio[1]?.frameState).toBe(9);
		expect(audio[1]?.audio?.every((byte) => byte === 0)).toBe(true);

		await h.session.close();
		await h.drained;
	});

	it("refuses the wire when the transport cannot set headers", async () => {
		const transport = new MockTransport({ headers: false });
		const session = new AsrSession({ wire: "protobuf", auth: { token: "t" }, transport });
		await expect(session.connect()).rejects.toMatchObject({ code: "unsupported" });
	});

	it("treats !is_interim && is_vad_finished as the session terminal", async () => {
		const h = harness({ wire: "protobuf", frameMs: 20 });
		await openProtobuf(h);

		h.transport.push(
			protoResponse({
				resultJson: JSON.stringify(resultPayload([{ text: "你好。", is_interim: false, is_vad_finished: false }])),
			}),
		);
		await tick();
		expect(h.session.transcript).toBeNull();

		h.transport.push(
			protoResponse({
				resultJson: JSON.stringify(resultPayload([{ text: "你好。", is_interim: false, is_vad_finished: true }])),
			}),
		);
		await tick();
		expect(h.session.transcript).toBe("你好。");

		await h.session.close();
		await h.drained;
	});
});

describe("AsrSession / frame defaults", () => {
	function frameMsOf(options: Partial<AsrSessionOptions> & { wire: "json" | "protobuf" }): number {
		const session = new AsrSession({
			auth: { token: "t" },
			transport: new MockTransport(),
			...options,
		});
		return session.snapshot.frameMs;
	}

	it("defaults to the frame length each wire was measured with", () => {
		// docs/protocol.md §5.2: JSON + PCM was verified at 100 ms, protobuf + PCM
		// and opus on either wire at 20 ms. Nothing else is a default.
		expect(frameMsOf({ wire: "json" })).toBe(100);
		expect(frameMsOf({ wire: "protobuf" })).toBe(20);
		expect(frameMsOf({ wire: "json", codec: "opus", encode: () => new Uint8Array(1) })).toBe(20);
		expect(frameMsOf({ wire: "protobuf", codec: "opus", encode: () => new Uint8Array(1) })).toBe(20);
	});

	it("keeps an explicit frame length", () => {
		expect(frameMsOf({ wire: "json", frameMs: 20 })).toBe(20);
	});
});

describe("AsrSession / session config", () => {
	it("merges overrides shallowly, including the extra bag", async () => {
		const h = harness({
			wire: "protobuf",
			sessionConfig: { enable_punctuation: false, extra: { input_mode: "chat" } },
		});
		await openProtobuf(h);
		const startSession = decodeRequest(h.transport.binaryFrames[1]!);
		expect(JSON.parse(startSession.payload ?? "{}")).toMatchObject({
			enable_punctuation: false,
			enable_speech_rejection: false,
			extra: { input_mode: "chat", enable_asr_twopass: true, cell_compress_rate: 8 },
		});
		await h.session.close();
		await h.drained;
	});

	it("asks for speech_opus when the caller supplies an encoder", async () => {
		const h = harness({
			wire: "json",
			codec: "opus",
			encode: () => Uint8Array.from([1, 2, 3]),
		});
		await openJson(h);
		const payload = configOf(envelopeOf(h.transport.textFrames[0] ?? "{}").payload);
		expect(payload.audio_format).toBe("speech_opus");
		expect(h.session.snapshot.frameMs).toBe(20);
		await h.session.close();
		await h.drained;
	});
});

/** The audio of a decoded TaskRequest as 16-bit samples. */
function pcmOf(bytes: Uint8Array): number[] {
	return Array.from(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2));
}

function envelopeOf(frame: string): { event: string; payload: string } {
	return JSON.parse(frame) as { event: string; payload: string };
}

function configOf(payload: string): Record<string, unknown> {
	return JSON.parse(payload) as Record<string, unknown>;
}

describe("AsrSession / failure handling", () => {
	it("ends the session when the token cannot even be resolved", async () => {
		// `getToken()` failing is the routine auth failure (expired token, refresh
		// endpoint down). It must not leave the session stuck in `connecting`.
		const h = harness({
			wire: "json",
			auth: {
				getToken: () => {
					throw new AsrError("auth_expired", "refresh failed");
				},
			},
		});

		await expect(h.session.connect()).rejects.toMatchObject({ code: "auth_expired" });
		await h.drained;

		expect(h.session.state).toBe("closed");
		expect(h.events.map((event) => event.type)).toEqual(["error", "closed"]);
	});

	it("rejects a SAMI token on the protobuf wire before touching the network", async () => {
		const h = harness({ wire: "protobuf", auth: { token: "sami" } });
		await expect(h.session.connect()).rejects.toMatchObject({ code: "config" });
		expect(h.transport.sent).toEqual([]);
		await h.drained;
	});

	it("does not offer a retry when the credential lacks the resource", async () => {
		const h = harness({ wire: "json" });
		const connecting = h.session.connect();
		await tick();
		h.transport.push(jsonMessage({ event: "TaskFailed", status: 40_000_000, statusText: "no access right" }));

		// 40000000 means auth got further and then hit a permission wall (§1.2), so
		// an identical retry fails identically: the hint must not promise one.
		await expect(connecting).rejects.toMatchObject({
			code: "server",
			status: 40_000_000,
			retryable: false,
		});
		await h.drained;
	});

	it("ends the event stream when the server rejects the session mid-session", async () => {
		const h = harness({ wire: "json" });
		await openJson(h);
		h.session.push(ramp(320));

		h.transport.push(jsonMessage({ event: "TaskFailed", status: 40_200_001, statusText: "IllegalToken" }));
		await h.drained;

		// §7.2: a mid-session rejection can only be wound down, and no socket close is
		// promised after `TaskFailed` — so `events` must end here, not at the idle
		// watchdog. This is what lets a UI leave "listening" on a server error.
		expect(h.events.map((event) => event.type)).toEqual(["open", "message", "message", "error", "closed"]);
		expect(h.session.state).toBe("closed");
		expect(await h.session.finish()).toMatchObject({
			text: null,
			error: { code: "auth_expired", status: 40_200_001 },
		});
	});

	it("keeps the text on screen when auth fails mid-session", async () => {
		const h = harness({ wire: "json" });
		await openJson(h);

		h.transport.push(jsonMessage({ payload: resultPayload([{ text: "你好。", is_interim: false }]) }));
		await tick();
		h.transport.push(jsonMessage({ event: "TaskFailed", status: 40_200_001, statusText: "IllegalToken" }));
		await tick();

		// §7.2's middle shape: a mid-session rejection can only be wound down, so
		// the text that already reached the screen survives, and the failure stays
		// retryable as a *new* session.
		const error = h.events.find((event) => event.type === "error");
		expect(error?.type === "error" ? (error.error as AsrError).retryable : undefined).toBe(true);
		expect(h.session.transcript).toBe("你好。");
		const outcome = await h.session.finish();
		expect(outcome).toMatchObject({ text: "你好。", timedOut: false, expired: false });
		expect(outcome.error).toMatchObject({
			code: "auth_expired",
			status: 40_200_001,
			retryable: true,
		});
	});

	it("reports one error event per in-band handshake failure", async () => {
		const h = harness({ wire: "json" });
		const connecting = h.session.connect();
		await tick();
		h.transport.push(jsonMessage({ event: "TaskFailed", status: 40_200_001, statusText: "IllegalToken" }));

		await expect(connecting).rejects.toMatchObject({ code: "auth_expired" });
		await h.drained;

		// The same failure used to produce an event from dispatch() and a second one
		// from the thrown copy that aborted connect().
		expect(h.events.filter((event) => event.type === "error")).toHaveLength(1);
	});

	it("holds audio back until the protobuf handshake has both acknowledgements", async () => {
		const h = harness({ wire: "protobuf", frameMs: 20 });
		const connecting = h.session.connect();
		await tick();

		// StartTask is out; TaskStarted/SessionStarted are not.
		h.session.push(ramp(320));
		expect(h.transport.binaryFrames.map((frame) => decodeRequest(frame).methodName)).toEqual(["StartTask"]);

		h.transport.push(protoResponse({ type: "TaskStarted" }));
		await tick();
		h.session.push(ramp(320));
		expect(h.transport.binaryFrames.map((frame) => decodeRequest(frame).methodName)).toEqual([
			"StartTask",
			"StartSession",
		]);

		h.transport.push(protoResponse({ type: "SessionStarted" }));
		await connecting;
		const audio = h.transport.binaryFrames
			.map((frame) => decodeRequest(frame))
			.filter((request) => request.methodName === "TaskRequest");
		// Both pre-handshake pushes are flushed in order once streaming starts.
		expect(audio).toHaveLength(2);

		await h.session.close();
		await h.drained;
	});

	it("keeps the transcript when the terminal message arrives before it", async () => {
		const h = harness({ wire: "json", terminalGraceMs: 20 });
		await openJson(h);

		const finishing = h.session.finish();
		await tick();
		h.transport.push(jsonMessage({ event: "TaskFinished" }));
		h.transport.push(jsonMessage({ payload: resultPayload([{ text: "你好", is_interim: false }]) }));

		// The protocol does not order the two, so the server's final result must
		// still land in the outcome.
		await expect(finishing).resolves.toEqual({
			text: "你好",
			timedOut: false,
			expired: false,
			error: null,
		});
		await h.session.close();
		await h.drained;
	});

	it("marks an unsolicited terminal message as expiry and drops later audio", async () => {
		const h = harness({ wire: "json" });
		await openJson(h);

		// The server ends the task after ~20 s without audio; nothing was asked for.
		h.transport.push(jsonMessage({ event: "TaskFinished" }));
		await tick();

		expect(() => {
			h.session.push(ramp(320));
		}).not.toThrow();
		await tick();
		const error = h.events.find((event) => event.type === "error");
		expect(error?.type === "error" && (error.error as AsrError).code).toBe("expired");

		const outcome = await h.session.finish();
		expect(outcome).toMatchObject({ text: null, timedOut: false, expired: true });
		// Expiry is a normal outcome, but still a retryable one: a new session works.
		expect(outcome.error).toMatchObject({ code: "expired", retryable: true });
		await h.session.close();
		await h.drained;
	});
});
