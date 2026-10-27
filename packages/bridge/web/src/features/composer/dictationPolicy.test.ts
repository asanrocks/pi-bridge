import { describe, expect, test } from "vitest";
import {
	asDictationEnding,
	credentialRetryDelay,
	dictationAvailability,
	dictationEndingNotice,
} from "./dictationPolicy.ts";

const ready = {
	connected: true,
	insecure: false,
	credential: { kind: "device" as const, deviceId: "device-1" },
	credentialError: null,
};

describe("dictationAvailability", () => {
	test("is ready with a credential on a secure, connected page", () => {
		expect(dictationAvailability(ready)).toEqual({ ready: true });
	});

	test("an insecure origin outranks every other reason", () => {
		// A connection cannot supply getUserMedia, so it must not be the answer.
		expect(dictationAvailability({ ...ready, insecure: true, connected: false, credential: null })).toEqual({
			ready: false,
			reason: "Dictation needs a secure context (https or localhost)",
		});
	});

	test("a cached credential does not survive the connection", () => {
		// Device ids never expire and tokens last hours, so readiness alone would
		// leave the control live with nothing to authorize it.
		expect(dictationAvailability({ ...ready, connected: false })).toEqual({
			ready: false,
			reason: "Dictation needs a daemon connection",
		});
	});

	test("names the credential failure while the retry is pending", () => {
		expect(
			dictationAvailability({ ...ready, credential: null, credentialError: "device registration failed" }),
		).toEqual({ ready: false, reason: "Dictation is unavailable: device registration failed" });
	});

	test("reports startup while the first credential request is in flight", () => {
		expect(dictationAvailability({ ...ready, credential: null })).toEqual({
			ready: false,
			reason: "Dictation is starting up",
		});
	});
});

describe("credentialRetryDelay", () => {
	test("doubles from two seconds and stops at thirty", () => {
		expect([0, 1, 2, 3, 4, 5, 10].map(credentialRetryDelay)).toEqual([
			2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
		]);
	});
});

describe("non-fatal endings", () => {
	test("only the three endings that keep the text are notices", () => {
		expect(asDictationEnding("expired")).toBe("expired");
		expect(asDictationEnding("timeout")).toBe("timeout");
		expect(asDictationEnding("aborted")).toBe("aborted");
		// A fatal code is a failure the user must act on, never a notice.
		expect(asDictationEnding("capture")).toBeNull();
		expect(asDictationEnding("auth_expired")).toBeNull();
	});

	test("each notice says the text was kept", () => {
		for (const ending of ["expired", "timeout", "aborted"] as const) {
			expect(dictationEndingNotice(ending)).toMatch(/text was kept/);
		}
	});
});
