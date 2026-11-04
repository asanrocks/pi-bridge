import { describe, expect, it } from "vitest";
import { sendOutcomeOf } from "./sendOutcome.ts";

describe("sendOutcomeOf", () => {
	it("reads an ok reply as admitted", () => {
		expect(sendOutcomeOf({ id: "1", ok: true })).toBe("admitted");
	});

	it("reads an ok:false reply as refused", () => {
		// A refusal is proof nothing ran: the composer restores the draft.
		expect(sendOutcomeOf({ id: "1", ok: false, error: "Invalid `model`" })).toBe("refused");
	});

	it("reads a missing reply as unknown, never as a failure", () => {
		// `useRpc.prompt` maps a transport rejection to undefined — the send may
		// have been admitted before the socket died, so the draft stays cleared
		// (regression: a mid-turn reconnect restored the text of a running turn,
		// inviting a duplicate send).
		expect(sendOutcomeOf(undefined)).toBe("unknown");
		expect(sendOutcomeOf(null)).toBe("unknown");
		expect(sendOutcomeOf("Disconnected")).toBe("unknown");
		expect(sendOutcomeOf({ id: "1" })).toBe("unknown");
	});
});
