import { describe, expect, it } from "vitest";
import { registerDevice } from "../src/device.ts";
import { AsrError } from "../src/errors.ts";
import { mintSamiToken } from "../src/token.ts";

interface Captured {
	url: string;
	init: RequestInit;
	/** Set only when the caller sent a string body, which is the case under test. */
	body?: string;
}

function mockFetch(response: { status?: number; body: unknown }): {
	fetch: typeof globalThis.fetch;
	calls: Captured[];
} {
	const calls: Captured[] = [];
	const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		calls.push({
			url: input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url,
			init: init ?? {},
			...(typeof init?.body === "string" ? { body: init.body } : {}),
		});
		const status = response.status ?? 200;
		const body = typeof response.body === "string" ? response.body : JSON.stringify(response.body);
		return Promise.resolve(new Response(body, { status }));
	};
	return { fetch, calls };
}

describe("registerDevice", () => {
	it("posts the fingerprint the endpoint expects and returns the device id", async () => {
		const { fetch, calls } = mockFetch({
			body: { device_id: 1_853_148_651_593_467, install_id: 1_853_148_651_597_563 },
		});
		const credentials = await registerDevice({ fetch, now: () => 1_700_000_000_000 });

		expect(credentials).toEqual({
			deviceId: "1853148651593467",
			installId: "1853148651597563",
		});

		const call = calls[0];
		expect(call?.url).toContain("log-klink.zijieapi.com/service/2/device_register/");
		expect(call?.url).toContain("aid=401734");
		expect(call?.url).toContain("_rticket=1700000000000");
		expect(call?.url).toContain("app_name=oime");
		// The body carries device identifiers, so redirects must not be followed.
		expect(call?.init.redirect).toBe("manual");

		const body = JSON.parse(String(call?.body)) as {
			magic_tag: string;
			header: Record<string, unknown>;
			_gen_time: number;
		};
		expect(body.magic_tag).toBe("ss_app_log");
		expect(body._gen_time).toBe(1_700_000_000_000);
		expect(body.header).toMatchObject({
			aid: 401734,
			package: "com.bytedance.android.doubaoime",
			app_name: "oime",
			device_id: 0,
		});
		expect(body.header.cdid).toEqual(expect.any(String));
		expect(body.header.openudid).toMatch(/^[0-9a-f]{16}$/);
	});

	it("accepts the device_id_str variant", async () => {
		const { fetch } = mockFetch({ body: { device_id_str: "999999999999999999999" } });
		await expect(registerDevice({ fetch })).resolves.toEqual({ deviceId: "999999999999999999999" });
	});

	it("fails loudly when the response carries no device id", async () => {
		const { fetch } = mockFetch({ body: { device_id: 0 } });
		await expect(registerDevice({ fetch })).rejects.toBeInstanceOf(AsrError);
	});

	it("reports HTTP errors with the body excerpt", async () => {
		const { fetch } = mockFetch({ status: 503, body: "busy" });
		await expect(registerDevice({ fetch })).rejects.toThrow(/HTTP 503: busy/);
	});
});

describe("mintSamiToken", () => {
	it("sends the access key and returns the token", async () => {
		const { fetch, calls } = mockFetch({ body: { Code: 0, Data: { sami_token: "minted" } } });
		// The response carries no expiry, so the caller gets an advisory one back to
		// schedule renewal at a session boundary.
		await expect(
			mintSamiToken({
				accessKey: "secret",
				fetch,
				requestId: "req-1",
				now: () => 1000,
				ttlMs: 500,
			}),
		).resolves.toEqual({ token: "minted", expiresAt: 1500 });

		const call = calls[0];
		expect(call?.url).toContain("ime.oceancloudapi.com/api/v1/user/get_config");
		expect(call?.init.method).toBe("POST");
		expect(call?.init.headers).toMatchObject({
			"X-Api-Access-Key": "secret",
			"X-Api-Request-Id": "req-1",
		});
		expect(JSON.parse(String(call?.body))).toEqual({ sami_app_key: "OrnqKvSSrs" });
	});

	it("rejects an unexpected payload instead of handing out an empty token", async () => {
		const { fetch } = mockFetch({ body: { Code: 1, Msg: "nope" } });
		await expect(mintSamiToken({ accessKey: "secret", fetch })).rejects.toMatchObject({
			code: "auth_expired",
		});
	});

	it("requires an access key", async () => {
		await expect(mintSamiToken({ accessKey: "" })).rejects.toMatchObject({ code: "config" });
	});
});
