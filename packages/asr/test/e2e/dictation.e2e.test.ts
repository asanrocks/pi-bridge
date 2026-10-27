/**
 * End-to-end suite: the only place the real service is contacted.
 *
 * Run with `PI_ASR_E2E=1 npm run test:e2e`. It is excluded from `npm test`, which
 * must stay offline and deterministic.
 *
 * Credentials are self-service: the device-registration endpoint takes no
 * secret (docs/protocol.md §1.4), so the suite can bootstrap itself on a clean
 * machine. It uses the JSON wire and raw PCM on purpose — that is the pair a
 * browser can actually use, and it needs no encoder.
 */
import { describe, expect, it } from "vitest";
import { registerDevice } from "../../src/device.ts";
import type { EditBatch, EditHost } from "../../src/edit/dictation.ts";
import { DictationEdit } from "../../src/edit/dictation.ts";
import { AsrSession } from "../../src/session.ts";
import { fixturePcm } from "./wav.ts";

const enabled = process.env.PI_ASR_E2E === "1";

/** `words()` form of the fixture transcript (test/fixtures/hello.wav), measured 2026-10-26. */
const EXPECTED_TRANSCRIPT = "Subjectiveperiodthepatientisa50";

/** Strip everything ASR is allowed to decide for itself, so the assertion is about the pipeline. */
function words(text: string | null): string {
	return (text ?? "").replaceAll(/[^\p{Script=Han}\p{Letter}\p{Number}]/gu, "");
}

class DocumentHost implements EditHost {
	text = "";
	batches: EditBatch[] = [];

	apply(batch: EditBatch): void {
		this.batches.push(batch);
		for (const op of batch.ops) {
			this.text = `${this.text.slice(0, op.start)}${op.text}${this.text.slice(op.end)}`;
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

describe.skipIf(!enabled)("end to end against the live service", () => {
	it("transcribes a spoken fixture through layer 1 and commits it through layer 2", async () => {
		const device = await registerDevice();
		const session = new AsrSession({ wire: "json", auth: { device } });

		const document = new DocumentHost();
		const edit = new DictationEdit(document);
		const partials: string[] = [];

		const pumped = (async () => {
			for await (const event of session.events) {
				if (event.type !== "text" || event.track !== 0) continue;
				partials.push(event.text);
				if (event.final) edit.commit(event.text);
				else edit.update(event.text);
			}
		})();

		await session.connect();
		edit.begin(document.text.length);

		// Real time, because the service derives its endpointing from the arrival
		// rate; feeding a burst changes what it hears.
		const pcm = fixturePcm("hello.wav");
		const chunk = 1600; // 100 ms at 16 kHz
		for (let offset = 0; offset < pcm.length; offset += chunk) {
			session.push(pcm.subarray(offset, offset + chunk));
			await sleep(100);
		}

		const outcome = await session.finish();
		await session.close();
		await pumped;

		expect(outcome.timedOut).toBe(false);
		expect(partials.length).toBeGreaterThan(1);
		expect(words(outcome.text)).toBe(EXPECTED_TRANSCRIPT);
		// Layer 2's document must match what layer 1 reported, which means the
		// interim revisions were applied as replacements rather than appended.
		expect(document.text).toBe(outcome.text);
		expect(document.batches.filter((batch) => batch.kind === "commit")).toHaveLength(1);

		const stats = session.snapshot;
		expect(stats.framesSent).toBeGreaterThan(2);
		expect(stats.openedAt).not.toBeNull();
		expect(stats.firstResultAt).not.toBeNull();
		expect(stats.finalAt).not.toBeNull();
		// §10.7: ready, first result and final are all observable, and the session
		// cannot be ready before it was constructed.
		expect(stats.openedAt ?? 0).toBeGreaterThanOrEqual(stats.startedAt);
		// 16 kHz mono, 100 ms frames: audio bytes plus framing, nowhere near the
		// 256 kbit/s ceiling implied by the sample rate.
		expect(stats.bytesSent).toBeGreaterThan(0);
	}, 120_000);

	it("returns no transcript for silence instead of failing", async () => {
		const device = await registerDevice();
		const session = new AsrSession({ wire: "json", auth: { device } });

		// Drain the queue without asserting on it: this case is about the absence
		// of a transcript, not about which events arrived.
		const pumped = (async () => {
			for await (const _event of session.events) {
				// nothing to do
			}
		})();

		await session.connect();
		for (let index = 0; index < 12; index += 1) {
			session.push(new Int16Array(1600));
			await sleep(100);
		}

		const outcome = await session.finish();
		await session.close();
		await pumped;

		expect(outcome.timedOut).toBe(false);
		expect(outcome.text ?? "").toBe("");
	}, 120_000);

	it("transcribes on the protobuf wire, which no other test covers", async () => {
		// The protobuf wire needs the `proto-version` header, so only Node can reach
		// it, and it only authenticates with the app key plus a registered device
		// (docs/protocol.md §1.2). Raw PCM keeps the suite free of an opus encoder.
		const device = await registerDevice();
		const session = new AsrSession({ wire: "protobuf", auth: { device }, frameMs: 20 });

		const finals: string[] = [];
		const pumped = (async () => {
			for await (const event of session.events) {
				if (event.type === "text" && event.track === 0 && event.final) finals.push(event.text);
			}
		})();

		await session.connect();
		const pcm = fixturePcm("hello.wav");
		const chunk = 320; // 20 ms, the frame size the protobuf reference clients use
		for (let offset = 0; offset < pcm.length; offset += chunk) {
			session.push(pcm.subarray(offset, offset + chunk));
			await sleep(20);
		}

		const outcome = await session.finish();
		await session.close();
		await pumped;

		expect(outcome).toMatchObject({ text: outcome.text, timedOut: false, expired: false });
		expect(outcome.error).toBeNull();
		expect(finals).toHaveLength(1);
		expect(words(outcome.text)).toBe(EXPECTED_TRANSCRIPT);
	}, 120_000);
});
