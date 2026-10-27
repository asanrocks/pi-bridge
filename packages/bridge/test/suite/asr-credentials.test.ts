// ASR (dictation) credentials: the daemon is the only party that can obtain one,
// because a page can neither mint a SAMI token nor register a device. These
// tests cover the provider's caching contract (the thing a real deployment
// pays for) and the RPC round trip that carries it, with both network calls
// injected — no real endpoint is contacted.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createAsrCredentialProvider } from "../../src/host/asr-credentials.ts";
import { Connection } from "../../src/host/connection.ts";
import { collectFrames, createWsPair, mockDaemonVerbs, waitForFrame, waitForOpen } from "./conn-helpers.ts";

describe("asr credentials provider", () => {
	it("registers one device per process and reuses it", async () => {
		const register = vi.fn(async () => ({ deviceId: "device-1" }));
		const provider = createAsrCredentialProvider({ accessKey: "", register });

		expect(await provider.get()).toEqual({ kind: "device", deviceId: "device-1" });
		expect(await provider.get()).toEqual({ kind: "device", deviceId: "device-1" });
		expect(register).toHaveBeenCalledTimes(1);
	});

	it("collapses concurrent requests into one registration", async () => {
		const register = vi.fn(async () => ({ deviceId: "device-1" }));
		const provider = createAsrCredentialProvider({ accessKey: "", register });

		const [first, second] = await Promise.all([provider.get(), provider.get()]);
		expect(first).toEqual(second);
		expect(register).toHaveBeenCalledTimes(1);
	});

	it("retries after a failed registration instead of caching the failure", async () => {
		const register = vi
			.fn<() => Promise<{ deviceId: string }>>()
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce({ deviceId: "device-1" });
		const provider = createAsrCredentialProvider({ accessKey: "", register });

		await expect(provider.get()).rejects.toThrow("offline");
		expect(await provider.get()).toEqual({ kind: "device", deviceId: "device-1" });
	});

	it("mints a token and refreshes it only near expiry", async () => {
		let now = 1_000_000;
		const mint = vi.fn(async () => ({ token: "tok-1", expiresAt: now + 5 * 60 * 60 * 1000 }));
		const provider = createAsrCredentialProvider({ accessKey: "key", register: never, mint, now: () => now });

		expect(await provider.get()).toEqual({ kind: "token", token: "tok-1", expiresAt: 1_000_000 + 5 * 3_600_000 });
		// Well inside the lifetime: the cached token is handed out again.
		now += 60_000;
		await provider.get();
		expect(mint).toHaveBeenCalledTimes(1);
		expect(mint).toHaveBeenCalledWith({ accessKey: "key" });
	});

	it("mints a replacement token inside the refresh margin", async () => {
		let now = 0;
		const mint = vi
			.fn<(options: { accessKey: string }) => Promise<{ token: string; expiresAt: number }>>()
			.mockResolvedValueOnce({ token: "tok-1", expiresAt: 600_000 })
			.mockResolvedValueOnce({ token: "tok-2", expiresAt: 1_200_000 });
		const provider = createAsrCredentialProvider({ accessKey: "key", register: never, mint, now: () => now });

		expect((await provider.get()).kind).toBe("token");
		// 60 s before the advisory expiry: the refresh margin opens.
		now = 550_000;
		expect(await provider.get()).toEqual({ kind: "token", token: "tok-2", expiresAt: 1_200_000 });
		expect(mint).toHaveBeenCalledTimes(2);
	});
});

describe("asrCredentials verb", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
	});

	it("replies with the daemon-held credential and no attachment", async () => {
		const { serverWs, clientWs } = await createWsPair();
		cleanups.push(() => {
			serverWs.close();
			clientWs.close();
		});
		const frames = collectFrames(clientWs);
		const conn = new Connection(serverWs, mockDaemonVerbs, null, false);
		cleanups.push(() => conn.dispose());

		await waitForOpen(clientWs);
		clientWs.send(JSON.stringify({ id: "1", verb: "asrCredentials" }));

		const reply = await waitForFrame(frames, (f) => (f as Record<string, unknown>).id === "1");
		expect(reply).toEqual({ id: "1", ok: true, auth: { kind: "device", deviceId: "mock-device" } });
	});
});

/** A provider configured for token auth must never register. */
function never(): Promise<{ deviceId: string }> {
	return Promise.reject(new Error("device registration must not run for token auth"));
}
