import { describe, expect, it } from "vitest";
import { anchorElapsed, clearInFlightAnchor, keepOnlyInFlightScope, resolveInFlightElapsed } from "./inFlight.ts";

describe("anchorElapsed", () => {
	it("anchors a just-started tool at now when the server reports no elapsed", () => {
		const a = anchorElapsed(undefined, 10_000, undefined);
		expect(a.localAnchor).toBe(10_000);
		expect(a.serverElapsed).toBeUndefined();
		// The live elapsed at the anchor instant is zero.
		expect(10_000 - a.localAnchor).toBe(0);
	});

	it("rebases a reconnecting client to its own clock (skew-proof)", () => {
		// The server says the tool has run 30s; the client clock is unrelated.
		const a = anchorElapsed(undefined, 10_000, 30_000);
		expect(a.localAnchor).toBe(-20_000);
		expect(10_000 - a.localAnchor).toBe(30_000);
	});

	it("keeps the anchor while the server value is stale, so elapsed grows", () => {
		const first = anchorElapsed(undefined, 10_000, 0);
		const later = anchorElapsed(first, 13_000, 0);
		expect(later).toBe(first);
		expect(13_000 - later.localAnchor).toBe(3_000);
	});

	it("re-anchors when the server value changes (reconnect resync)", () => {
		const first = anchorElapsed(undefined, 10_000, 0);
		// A reconnect initial sync arrives 20s in, at client time 40_000.
		const resynced = anchorElapsed(first, 40_000, 20_000);
		expect(resynced.localAnchor).toBe(20_000);
		expect(40_000 - resynced.localAnchor).toBe(20_000);
		expect(resynced.serverElapsed).toBe(20_000);
	});

	it("re-anchors when a server value appears after an anchorless start", () => {
		const first = anchorElapsed(undefined, 10_000, undefined);
		const resynced = anchorElapsed(first, 15_000, 12_000);
		expect(resynced.localAnchor).toBe(3_000);
		expect(15_000 - resynced.localAnchor).toBe(12_000);
	});
});

describe("in-flight anchor scope", () => {
	it("does not reuse another session's anchor for a colliding tool-call id", () => {
		// Session A's tool ran 30s when the switch happened; session B reuses the
		// same tool-call id and reports a fresh start. Without a per-session key
		// the stale anchor leaked, showing B's tool as already 40s in.
		clearInFlightAnchor("scope-a", "tc-shared");
		clearInFlightAnchor("scope-b", "tc-shared");
		expect(resolveInFlightElapsed("scope-a", "tc-shared", 10_000, 30_000)).toBe(30_000);
		keepOnlyInFlightScope("scope-b");
		expect(resolveInFlightElapsed("scope-b", "tc-shared", 40_000, 0)).toBe(0);
	});

	it("drops the anchors of a session left behind", () => {
		clearInFlightAnchor("scope-c", "tc-c");
		expect(resolveInFlightElapsed("scope-c", "tc-c", 1_000, 0)).toBe(0);
		// Leaving scope-c for scope-d discards scope-c's running anchor, so a
		// later return to scope-c starts fresh rather than resuming the old one.
		keepOnlyInFlightScope("scope-d");
		expect(resolveInFlightElapsed("scope-c", "tc-c", 90_000, 0)).toBe(0);
	});
});
