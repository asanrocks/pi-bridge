import { describe, expect, test } from "vitest";
import { DraftOwnership } from "./draftOwnership.ts";

describe("DraftOwnership", () => {
	test("a claimed draft stays writable while the composer shows it", () => {
		const ownership = new DraftOwnership("proj/stem");
		ownership.claim();
		expect(ownership.writable).toBe(true);
		// Re-asserting the same address is not a change (a reconnect or an
		// optimistic open that resolves onto the same session).
		expect(ownership.setCurrent("proj/stem")).toBe(false);
		expect(ownership.writable).toBe(true);
	});

	test("a draft swap ends the utterance's ownership", () => {
		const ownership = new DraftOwnership("proj/one");
		ownership.claim();
		expect(ownership.setCurrent("proj/two")).toBe(true);
		expect(ownership.writable).toBe(false);
	});

	test("switching back does not restore ownership", () => {
		// The old text was replaced and re-restored from storage in between, so the
		// offsets the utterance owns no longer describe anything.
		const ownership = new DraftOwnership("proj/one");
		ownership.claim();
		ownership.setCurrent("proj/two");
		ownership.setCurrent("proj/one");
		expect(ownership.writable).toBe(false);
	});

	test("nothing is writable before an utterance claims the draft", () => {
		expect(new DraftOwnership("proj/stem").writable).toBe(false);
	});

	test("a new utterance claims the draft it starts in", () => {
		const ownership = new DraftOwnership("proj/one");
		ownership.claim();
		ownership.setCurrent("proj/two");
		ownership.claim();
		expect(ownership.writable).toBe(true);
	});
});
