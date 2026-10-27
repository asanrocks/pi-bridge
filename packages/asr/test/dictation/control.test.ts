import { describe, expect, it } from "vitest";
import type { DictationOptions, DictationPhase, DictationResult } from "../../src/dictation/control.ts";
import { Dictation, isFatalError } from "../../src/dictation/control.ts";
import type { EditBatch, EditHost } from "../../src/edit/dictation.ts";
import { applyBatch } from "../../src/edit/dictation.ts";
import { AsrError } from "../../src/errors.ts";
import type { FinishOutcome } from "../../src/session.ts";
import { AsrSession } from "../../src/session.ts";
import { FakeMic, speech } from "../../src/testing/fake-mic.ts";
import { jsonMessage, MockTransport, resultPayload, tick } from "../../src/testing/mock-transport.ts";
import type { AsrEvent } from "../../src/types.ts";

interface Harness {
	dictation: Dictation;
	/** One per `start()`; the microphone is a per-utterance resource. */
	mics: FakeMic[];
	transports: MockTransport[];
	batches: EditBatch[];
	phases: DictationPhase[];
	doc: { text: string };
	mic(): FakeMic;
	transport(): MockTransport;
}

/**
 * Drives the real `AsrSession` over `MockTransport`, so the state machine is
 * tested against the wire behaviour it will actually meet, not a session stub.
 */
function harness(overrides: Partial<DictationOptions> = {}): Harness {
	const mics: FakeMic[] = [];
	const transports: MockTransport[] = [];
	const batches: EditBatch[] = [];
	const phases: DictationPhase[] = [];
	const doc = { text: "" };

	const host: EditHost = {
		read: () => ({ text: doc.text }),
		apply: (batch) => {
			batches.push(batch);
			doc.text = applyBatch(doc.text, batch);
		},
	};

	const dictation = new Dictation({
		session: { wire: "json", auth: { token: "token" }, handshakeTimeoutMs: 100 },
		host,
		caret: () => doc.text.length,
		createSession: (options) => {
			const transport = new MockTransport();
			transports.push(transport);
			return new AsrSession({ ...options, transport });
		},
		openMic: (options) => {
			const mic = new FakeMic(options);
			mics.push(mic);
			return Promise.resolve(mic);
		},
		...overrides,
	});
	dictation.subscribe((phase) => phases.push(phase));

	return {
		dictation,
		mics,
		transports,
		batches,
		phases,
		doc,
		mic: () => {
			const mic = mics.at(-1);
			if (mic === undefined) throw new Error("no microphone was opened");
			return mic;
		},
		transport: () => {
			const transport = transports.at(-1);
			if (transport === undefined) throw new Error("no session was created");
			return transport;
		},
	};
}

/** Start, deliver one batch, then acknowledge `StartTask`: `listening{sending}`. */
async function listen(h: Harness): Promise<void> {
	void h.dictation.start();
	await tick();
	h.mic().emit(speech());
	h.transport().push(jsonMessage({ event: "TaskStarted" }));
	await tick();
}

function failure(phase: DictationPhase): AsrError {
	if (phase.kind !== "failed") throw new Error(`expected a failed phase, got ${phase.kind}`);
	return phase.error;
}

describe("Dictation phases", () => {
	it("listens on the first audio batch, and reports the handshake separately", async () => {
		const h = harness();
		void h.dictation.start();
		await tick();
		expect(h.dictation.phase).toEqual({ kind: "preparing" });

		h.mic().emit(speech());
		await tick();
		// The microphone is the part the user asked for; the handshake is only the
		// second half of sending, so it must not hold the phase back.
		expect(h.dictation.phase).toEqual({ kind: "listening", sending: false });

		h.transport().push(jsonMessage({ event: "TaskStarted" }));
		await tick();
		expect(h.dictation.phase).toEqual({ kind: "listening", sending: true });
		expect(h.phases).toEqual([
			{ kind: "preparing" },
			{ kind: "listening", sending: false },
			{ kind: "listening", sending: true },
		]);
	});

	it("does not listen on a level threshold: silence is still a live microphone", async () => {
		const h = harness();
		void h.dictation.start();
		await tick();
		h.transport().push(jsonMessage({ event: "TaskStarted" }));
		await tick();
		// A closed handshake is not evidence of a working microphone.
		expect(h.dictation.phase).toEqual({ kind: "preparing" });

		const readings: boolean[] = [];
		h.dictation.onLevel((reading) => readings.push(reading.speaking));
		h.mic().emit(new Int16Array(320));
		await tick();
		expect(h.dictation.phase).toEqual({ kind: "listening", sending: true });
		expect(readings).toEqual([false]);
	});

	it("meters every batch and forwards the same samples to the session", async () => {
		const h = harness();
		await listen(h);

		const readings: number[] = [];
		h.dictation.onLevel((reading) => readings.push(reading.level));
		for (let batch = 0; batch < 20; batch += 1) h.mic().emit(speech());
		h.mic().emit(new Int16Array(320));

		expect(readings.length).toBe(21);
		expect(readings[0]).toBeGreaterThan(0.7);
		expect(readings.at(-1)).toBe(0);
		// 21 batches of 20 ms; the JSON wire frames PCM at 100 ms.
		expect(h.transport().binaryFrames.length).toBeGreaterThan(0);
	});
});

describe("Dictation commit and cancel", () => {
	it("commits the terminal transcript when the button is released", async () => {
		const h = harness();
		await listen(h);
		h.mic().emit(speech());

		const stopping = h.dictation.stop();
		await tick();
		h.transport().push(
			jsonMessage({
				event: "TaskFinished",
				payload: resultPayload([{ text: "你好", is_interim: false }]),
			}),
		);
		const result = await stopping;

		expect(result.text).toBe("你好");
		expect(result.error).toBeNull();
		expect(h.doc.text).toBe("你好");
		expect(h.batches.map((batch) => batch.kind)).toEqual(["preedit", "commit"]);
		expect(h.dictation.phase).toEqual({ kind: "idle" });
		expect(h.mic().stopped).toBe(true);
	});

	it("cancels a tap that ends before the handshake, without finishing the session", async () => {
		const h = harness();
		void h.dictation.start();
		await tick();

		await h.dictation.stop();

		expect(h.doc.text).toBe("");
		expect(h.batches.map((batch) => batch.kind)).toEqual(["cancel"]);
		expect(h.dictation.phase).toEqual({ kind: "idle" });
		expect(h.transport().textFrames.some((frame) => frame.includes("FinishTask"))).toBe(false);
	});

	it("removes the pre-edit on cancel and leaves the host text alone", async () => {
		const h = harness();
		h.doc.text = "前缀：";
		await listen(h);
		h.transport().push(jsonMessage({ payload: resultPayload([{ text: "你好", is_interim: true }]) }));
		await tick();
		expect(h.doc.text).toBe("前缀：你好");

		await h.dictation.cancel();

		expect(h.doc.text).toBe("前缀：");
		expect(h.batches.map((batch) => batch.kind)).toEqual(["preedit", "cancel"]);
		expect(h.dictation.phase).toEqual({ kind: "idle" });
	});

	it("commits what arrived when the server ends the task on its own (~20 s silence)", async () => {
		const h = harness();
		await listen(h);
		h.transport().push(
			jsonMessage({
				event: "TaskFinished",
				payload: resultPayload([{ text: "早", is_interim: false }]),
			}),
		);
		await tick();
		await tick();

		expect(h.doc.text).toBe("早");
		// Expiry is a documented outcome, not a failure the user must dismiss.
		expect(h.dictation.phase).toEqual({ kind: "idle" });
		expect(h.dictation.result.error?.code).toBe("expired");
		expect(h.dictation.result.error?.retryable).toBe(true);
	});
});

/**
 * A session whose events and terminal outcome the test delivers.
 *
 * The transport harness cannot stage this block's race: closing a real session
 * ends its event iterator, so "cancel, then the final transcript lands" has no
 * wire representation. `close()` here deliberately does *not* settle a pending
 * `finish()` for the same reason — the guarantee under test is that the caller's
 * cancel wins even when the server's answer arrives afterwards.
 */
interface ScriptedSession {
	session: AsrSession;
	/** One surface event, as the wire pump would report it. */
	emit: (event: AsrEvent) => void;
	/** Resolve the pending `finish()` with the server's terminal outcome. */
	settle: (outcome: FinishOutcome) => void;
	readonly closed: string[];
}

function scriptedSession(): ScriptedSession {
	const queue: AsrEvent[] = [];
	const closed: string[] = [];
	let ended = false;
	let wake: (() => void) | undefined;
	let resolveFinish: ((outcome: FinishOutcome) => void) | undefined;

	const session = {
		connect: () => Promise.resolve(),
		push: () => undefined,
		finish: () =>
			new Promise<FinishOutcome>((resolve) => {
				resolveFinish = resolve;
			}),
		close: (reason = "client closed") => {
			// Closing an already-closed session is a no-op, exactly as the real one
			// reports it: a cancel and the settlement it outranks both close it.
			if (ended) return Promise.resolve();
			closed.push(reason);
			ended = true;
			wake?.();
			return Promise.resolve();
		},
		events: {
			[Symbol.asyncIterator]: () => ({
				next: async (): Promise<IteratorResult<AsrEvent>> => {
					for (;;) {
						const event = queue.shift();
						if (event !== undefined) return { done: false, value: event };
						if (ended) return { done: true, value: undefined };
						await new Promise<void>((resolve) => {
							wake = resolve;
						});
					}
				},
			}),
		},
	} as unknown as AsrSession;

	return {
		session,
		closed,
		emit: (event) => {
			queue.push(event);
			wake?.();
		},
		settle: (outcome) => {
			const resolve = resolveFinish;
			resolveFinish = undefined;
			resolve?.(outcome);
		},
	};
}

interface ScriptedHarness {
	dictation: Dictation;
	sessions: ScriptedSession[];
	mics: FakeMic[];
	batches: EditBatch[];
	doc: { text: string };
}

function scripted(doc: string = ""): ScriptedHarness {
	const sessions: ScriptedSession[] = [];
	const mics: FakeMic[] = [];
	const batches: EditBatch[] = [];
	const text = { text: doc };

	const dictation = new Dictation({
		session: { wire: "json", auth: { token: "token" } },
		host: {
			read: () => ({ text: text.text }),
			apply: (batch) => {
				batches.push(batch);
				text.text = applyBatch(text.text, batch);
			},
		},
		caret: () => text.text.length,
		createSession: () => {
			const record = scriptedSession();
			sessions.push(record);
			return record.session;
		},
		openMic: (options) => {
			const mic = new FakeMic(options);
			mics.push(mic);
			return Promise.resolve(mic);
		},
	});

	return { dictation, sessions, mics, batches, doc: text };
}

/** One interim track-0 revision, as the server rewrites it while listening. */
function interim(text: string): AsrEvent {
	return { type: "text", track: 0, text, interim: true, vadFinished: false, nonstream: false, final: false };
}

function committed(text: string): FinishOutcome {
	return { text, timedOut: false, expired: false, error: null };
}

describe("Dictation cancellation owns the ending", () => {
	it("discards the terminal transcript when the utterance is cancelled while committing", async () => {
		const h = scripted("前缀：");
		await h.dictation.start();
		h.sessions[0]?.emit(interim("你好"));
		await tick();
		expect(h.doc.text).toBe("前缀：你好");

		const stopping = h.dictation.stop();
		await tick();
		expect(h.dictation.phase).toEqual({ kind: "committing" });
		// The utterance is still running: a second press must not start another.
		expect(h.dictation.isActive).toBe(true);

		await h.dictation.cancel();
		expect(h.doc.text).toBe("前缀：");
		expect(h.dictation.phase).toEqual({ kind: "idle" });

		// The server answers after the user gave up.
		h.sessions[0]?.settle(committed("你好。"));
		const result = await stopping;

		expect(result.text).toBeNull();
		expect(h.doc.text).toBe("前缀：");
		expect(h.batches.map((batch) => batch.kind)).toEqual(["preedit", "cancel"]);
		expect(h.sessions[0]?.closed).toEqual(["dictation cancelled"]);
		expect(h.mics[0]?.stopped).toBe(true);
		// Nothing is left to start over: the controller is idle, not stuck.
		expect(h.dictation.isActive).toBe(false);
	});

	it("keeps a cancelled utterance from writing into the one that replaced it", async () => {
		const h = scripted();
		await h.dictation.start();
		h.sessions[0]?.emit(interim("旧"));
		await tick();

		const stopping = h.dictation.stop();
		await tick();
		await h.dictation.cancel();
		expect(h.doc.text).toBe("");

		// A second utterance in the same document, which must own it alone.
		await h.dictation.start();
		expect(h.sessions).toHaveLength(2);
		h.sessions[1]?.emit(interim("新"));
		await tick();
		const finishing = h.dictation.stop();
		await tick();
		h.sessions[1]?.settle(committed("新。"));
		expect((await finishing).text).toBe("新。");
		expect(h.doc.text).toBe("新。");

		// Only now does the abandoned utterance's final arrive.
		h.sessions[0]?.settle(committed("旧。"));
		expect((await stopping).text).toBeNull();
		expect(h.doc.text).toBe("新。");
	});

	it("commits once when the pump and the release both end the utterance", async () => {
		const h = scripted();
		await h.dictation.start();
		h.sessions[0]?.emit(interim("你好"));
		await tick();

		const stopping = h.dictation.stop();
		await tick();
		// The terminal text event races the pending finish; neither may commit twice.
		h.sessions[0]?.emit({
			type: "text",
			track: 0,
			text: "你好。",
			interim: false,
			vadFinished: true,
			nonstream: false,
			final: true,
		});
		await tick();
		h.sessions[0]?.settle(committed("你好。"));

		expect((await stopping).text).toBe("你好。");
		expect(h.doc.text).toBe("你好。");
		// The interim revision, the terminal one, then the single commit.
		expect(h.batches.map((batch) => batch.kind)).toEqual(["preedit", "preedit", "commit"]);
		expect(h.sessions[0]?.closed).toEqual(["dictation finished"]);
	});

	it("tolerates repeated cancellation and disposal", async () => {
		const h = scripted();
		await h.dictation.start();

		await h.dictation.cancel();
		await h.dictation.cancel();
		await h.dictation.dispose();

		expect(h.dictation.phase).toEqual({ kind: "idle" });
		expect(h.dictation.isActive).toBe(false);
		expect(h.sessions[0]?.closed).toEqual(["dictation cancelled"]);
		expect(h.mics[0]?.stopped).toBe(true);
	});
});

describe("Dictation caret", () => {
	it("refuses a host that cannot say where the sentence starts", () => {
		expect(
			() =>
				new Dictation({
					session: { wire: "json", auth: { token: "token" } },
					host: { apply: () => undefined },
				}),
		).toThrow(/caret/);
	});

	it("derives the insertion point from a host that reports one", async () => {
		const batches: EditBatch[] = [];
		// A DOM target is exactly this shape: `read()` gives text and caret together.
		const host: EditHost & { read: () => { text: string; caret: number } } = {
			read: () => ({ text: "ab", caret: 2 }),
			apply: (batch) => {
				batches.push(batch);
			},
		};
		const dictation = new Dictation({
			session: { wire: "json", auth: { token: "token" } },
			host,
			openMic: () => Promise.reject(new AsrError("capture", "mic: denied")),
		});

		await dictation.start();

		expect(batches.at(-1)?.span).toEqual({ start: 2, end: 2 });
	});

	it("reports a host that reads text but no caret as a configuration error", async () => {
		const dictation = new Dictation({
			session: { wire: "json", auth: { token: "token" } },
			host: { read: () => ({ text: "ab" }), apply: () => undefined },
			openMic: () => Promise.reject(new AsrError("capture", "mic: denied")),
		});

		await dictation.start();

		expect(dictation.phase).toMatchObject({ kind: "failed", error: { code: "config" } });
	});
});

describe("Dictation failures", () => {
	it("fails fast when the microphone is denied, without waiting for the handshake", async () => {
		const h = harness({
			openMic: () =>
				Promise.reject(
					new AsrError("capture", "mic: getUserMedia failed (NotAllowedError)", {
						retryable: false,
					}),
				),
		});

		await h.dictation.start();

		expect(failure(h.dictation.phase)).toMatchObject({ code: "capture", retryable: false });
		expect(h.doc.text).toBe("");
		expect(h.batches.map((batch) => batch.kind)).toEqual(["cancel"]);
	});

	it("reports a rejected credential as a retryable failure", async () => {
		const h = harness();
		void h.dictation.start();
		await tick();
		h.transport().push(
			jsonMessage({
				event: "TaskStarted",
				status: 40_200_001,
				statusText: "IllegalToken",
			}),
		);
		await tick();
		await tick();

		const error = failure(h.dictation.phase);
		expect(error.code).toBe("auth_expired");
		expect(error.retryable).toBe(true);
	});

	it("keeps the transcript and reports the error when the finish wait times out", async () => {
		const h = harness({
			session: { wire: "json", auth: { token: "token" }, finishTimeoutMs: 20 },
		});
		await listen(h);
		h.transport().push(jsonMessage({ payload: resultPayload([{ text: "你好", is_interim: true }]) }));
		await tick();

		const result = await h.dictation.stop();

		// The interim text is still a pre-edit and the server never confirmed it, so
		// it is dropped rather than committed as if it were the transcript.
		expect(result.text).toBeNull();
		expect(result.error?.code).toBe("timeout");
		expect(h.doc.text).toBe("");
		expect(h.dictation.phase).toEqual({ kind: "idle" });
	});

	it("finishes the utterance when the device disappears mid-dictation", async () => {
		const h = harness();
		await listen(h);
		h.transport().push(jsonMessage({ payload: resultPayload([{ text: "你好", is_interim: true }]) }));
		await tick();

		h.mic().end();
		await tick();
		h.transport().push(
			jsonMessage({
				event: "TaskFinished",
				payload: resultPayload([{ text: "你好", is_interim: false }]),
			}),
		);
		await tick();
		await tick();

		expect(h.doc.text).toBe("你好");
		expect(h.dictation.phase).toEqual({ kind: "idle" });
	});

	it("leaves listening as soon as the server rejects the session", async () => {
		const h = harness();
		await listen(h);

		h.transport().push(jsonMessage({ event: "TaskFailed", status: 40_200_001, statusText: "IllegalToken" }));
		await tick();
		await tick();

		// No release, no finish wait, no idle watchdog: the failure ends the utterance
		// and the button is free again with the reason attached.
		expect(failure(h.dictation.phase).code).toBe("auth_expired");
		expect(h.dictation.isActive).toBe(false);
		expect(h.mic().stopped).toBe(true);
		expect(h.doc.text).toBe("");
	});

	it("reports a microphone that never delivers audio when a timeout is set", async () => {
		const h = harness({ preparingTimeoutMs: 5 });
		void h.dictation.start();
		await tick();
		h.transport().push(jsonMessage({ event: "TaskStarted" }));
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(failure(h.dictation.phase).code).toBe("capture");
		expect(h.doc.text).toBe("");
	});
});

describe("Dictation settlement", () => {
	it("reports the committed transcript after it reached the host", async () => {
		const h = harness();
		const settled: Array<{ text: string | null; error: string | null; doc: string }> = [];
		h.dictation.onSettled((result) => {
			settled.push({ text: result.text, error: result.error?.code ?? null, doc: h.doc.text });
		});

		await listen(h);
		h.mic().emit(speech());
		const stopping = h.dictation.stop();
		await tick();
		h.transport().push(
			jsonMessage({
				event: "TaskFinished",
				payload: resultPayload([{ text: "你好", is_interim: false }]),
			}),
		);
		await stopping;

		// The host already holds the text when the listener runs.
		expect(settled).toEqual([{ text: "你好", error: null, doc: "你好" }]);
	});

	it("reports a cancellation as an empty result, once per utterance", async () => {
		const h = scripted("前缀：");
		const settled: DictationResult[] = [];
		h.dictation.onSettled((result) => settled.push(result));

		await h.dictation.start();
		h.sessions[0]?.emit(interim("你好"));
		await tick();
		await h.dictation.cancel();
		// Cancelling again is not a second utterance.
		await h.dictation.cancel();

		expect(settled).toEqual([{ text: null, finish: null, error: null }]);
		expect(h.doc.text).toBe("前缀：");
	});

	it("reports a failed start with its reason", async () => {
		const h = harness({
			openMic: () =>
				Promise.reject(new AsrError("capture", "mic: getUserMedia failed (NotAllowedError)", { retryable: false })),
		});
		const settled: DictationResult[] = [];
		h.dictation.onSettled((result) => settled.push(result));

		await h.dictation.start();

		expect(settled).toHaveLength(1);
		expect(settled[0]?.text).toBeNull();
		expect(settled[0]?.error?.code).toBe("capture");
		expect(isFatalError(settled[0]!.error!)).toBe(true);
	});

	it("reports an expiry once, with the text it kept, as a non-fatal ending", async () => {
		const h = harness();
		const settled: Array<{ code: string | null; text: string | null; doc: string }> = [];
		h.dictation.onSettled((result) => {
			settled.push({ code: result.error?.code ?? null, text: result.text, doc: h.doc.text });
		});

		await listen(h);
		h.transport().push(
			jsonMessage({
				event: "TaskFinished",
				payload: resultPayload([{ text: "早", is_interim: false }]),
			}),
		);
		await tick();
		await tick();

		expect(settled).toEqual([{ code: "expired", text: "早", doc: "早" }]);
		expect(isFatalError(h.dictation.result.error!)).toBe(false);
	});

	it("reports a finish timeout once, with no committed text", async () => {
		const h = harness({ session: { wire: "json", auth: { token: "token" }, finishTimeoutMs: 20 } });
		const settled: Array<{ code: string | null; text: string | null }> = [];
		h.dictation.onSettled((result) => settled.push({ code: result.error?.code ?? null, text: result.text }));

		await listen(h);
		h.transport().push(jsonMessage({ payload: resultPayload([{ text: "你好", is_interim: true }]) }));
		await tick();
		await h.dictation.stop();

		expect(settled).toEqual([{ code: "timeout", text: null }]);
	});

	it("notifies once when the release, the terminal message, and a cancel overlap", async () => {
		const h = scripted();
		const settled: Array<string | null> = [];
		h.dictation.onSettled((result) => settled.push(result.text));

		await h.dictation.start();
		h.sessions[0]?.emit(interim("你好"));
		await tick();

		const stopping = h.dictation.stop();
		await tick();
		await h.dictation.cancel();
		h.sessions[0]?.settle(committed("你好。"));
		await stopping;
		await tick();

		expect(settled).toEqual([null]);
	});

	it("stops notifying after unsubscribe", async () => {
		const h = scripted();
		const first: Array<string | null> = [];
		const off = h.dictation.onSettled((result) => first.push(result.text));

		await h.dictation.start();
		const stopping = h.dictation.stop();
		await tick();
		h.sessions[0]?.settle(committed("一"));
		await stopping;
		expect(first).toEqual(["一"]);

		off();
		const second: Array<string | null> = [];
		h.dictation.onSettled((result) => second.push(result.text));
		await h.dictation.start();
		const finishing = h.dictation.stop();
		await tick();
		h.sessions[1]?.settle(committed("二"));
		await finishing;

		expect(second).toEqual(["二"]);
	});

	it("clears settlement listeners on disposal", async () => {
		const h = scripted();
		const seen: Array<string | null> = [];
		h.dictation.onSettled((result) => seen.push(result.text));

		await h.dictation.start();
		await h.dictation.cancel();
		expect(seen).toEqual([null]);

		await h.dictation.dispose();
		await h.dictation.start();
		const stopping = h.dictation.stop();
		await tick();
		h.sessions[1]?.settle(committed("二"));
		await stopping;

		expect(seen).toEqual([null]);
	});
});
