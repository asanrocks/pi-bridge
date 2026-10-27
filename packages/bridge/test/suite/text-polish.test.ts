// Text polish: the daemon speaks WeChat IME's `Kb-CmdId: 4549` because a page
// cannot (AES-256-ECB, `secp128r1` ECDH, signed headers, no CORS). These tests
// drive the provider against a fake service that speaks the real protocol —
// including the ECDH handshake and the signed headers — so the wire shape, the
// identity file and the failure vocabulary are asserted without contacting
// anything. Nothing here reaches the network.

import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
} from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Connection } from "../../src/host/connection.ts";
import { createTextPolishProvider } from "../../src/host/text-polish.ts";
import { collectFrames, createWsPair, mockDaemonVerbs, waitForFrame, waitForOpen } from "./conn-helpers.ts";

// ---------------------------------------------------------------- protocol

const BOOTSTRAP_KEY = Buffer.from("G7E1C8B0D7D7E4L3J2U9D6W0B2M8Q6O5");
const SIGN_SALT = "aI0wC6qT1nB3nN5r";
/** The documented signing order, restated here so the test checks the wire
 * against the spec rather than against the implementation's own table. */
const SIGN_ORDER: Record<string, string[]> = {
	timestamp: [],
	ecdh: ["Kb-OsType", "Kb-Version", "Kb-Scene", "Kb-TimeStamp", "Kb-BodyMd5", "Kb-TraceId", "Kb-TaskId"],
	register: [
		"Kb-OsType",
		"Kb-Version",
		"Kb-Scene",
		"Kb-TimeStamp",
		"Kb-BodyMd5",
		"Kb-GenUinToken",
		"Kb-TraceId",
		"Kb-TaskId",
	],
	api: [
		"Kb-OsType",
		"Kb-Version",
		"Kb-Scene",
		"Kb-CmdId",
		"Kb-SubCmdId",
		"Kb-TimeStamp",
		"Kb-BodyMd5",
		"Kb-Uin",
		"Kb-TraceId",
		"Kb-TaskId",
	],
};

const PATH_KIND: Record<string, string> = {
	"/timestamp": "timestamp",
	"/oauth_pubkey_v2": "ecdh",
	"/gen_uin_v2": "register",
	"/api_v2": "api",
};

function varint(value: number): Buffer {
	const out: number[] = [];
	let rest = value;
	while (rest > 0x7f) {
		out.push((rest & 0x7f) | 0x80);
		rest = Math.floor(rest / 128);
	}
	out.push(rest);
	return Buffer.from(out);
}

const varintField = (field: number, value: number): Buffer => Buffer.concat([varint(field << 3), varint(value)]);

const bytesField = (field: number, value: string | Buffer): Buffer => {
	const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
	return Buffer.concat([varint((field << 3) | 2), varint(bytes.length), bytes]);
};

function readVarint(buf: Buffer, pos: number): [number, number] {
	let value = 0;
	let shift = 0;
	let byte = 0;
	let next = pos;
	do {
		byte = buf[next] ?? 0;
		next += 1;
		value += (byte & 0x7f) * 2 ** shift;
		shift += 7;
	} while (byte & 0x80);
	return [value, next];
}

function readFields(buf: Buffer): Map<number, number | Buffer> {
	const out = new Map<number, number | Buffer>();
	let pos = 0;
	while (pos < buf.length) {
		const [tag, afterTag] = readVarint(buf, pos);
		const field = tag >> 3;
		pos = afterTag;
		if ((tag & 7) === 0) {
			const [value, next] = readVarint(buf, pos);
			out.set(field, value);
			pos = next;
		} else {
			const [length, start] = readVarint(buf, pos);
			out.set(field, buf.subarray(start, start + length));
			pos = start + length;
		}
	}
	return out;
}

const aes = (data: Buffer, key: Buffer, encrypt: boolean): Buffer => {
	const cipher = encrypt ? createCipheriv("aes-256-ecb", key, null) : createDecipheriv("aes-256-ecb", key, null);
	return Buffer.concat([cipher.update(data), cipher.final()]);
};

const md5Upper = (data: Buffer): string => createHash("md5").update(data).digest("hex").toUpperCase();
const sha256Upper = (data: string): string => createHash("sha256").update(data).digest("hex").toUpperCase();

// ------------------------------------------------------------- fake service

interface FakeService {
	fetch: typeof fetch;
	requests: Array<{ path: string; headers: Record<string, string>; body: Buffer }>;
	/** Every draft the service was asked to arrange, in arrival order. */
	drafts: string[];
	/** Highest number of `/api_v2` requests that were in flight at once. */
	peakConcurrency: number;
	replyCompression?: string;
	failStatus?: number;
	/** Never answers; only an abort ends the call. */
	hang?: boolean;
}

function fakeService(options: { arrange?: (text: string) => string; delayMs?: number } = {}): FakeService {
	const keyPair = generateKeyPairSync("ec", { namedCurve: "secp128r1" });
	const der = keyPair.publicKey.export({ type: "spki", format: "der" });
	const header = der.subarray(0, -33);
	const serverPointHex = der.subarray(-33).toString("hex").toUpperCase();

	const service: FakeService = {
		fetch: async () => new Response(null),
		requests: [],
		drafts: [],
		peakConcurrency: 0,
	};
	let controlKey: Buffer | null = null;
	let inFlight = 0;

	const respond = (body: Buffer): Response =>
		new Response(new Uint8Array(body), {
			status: 200,
			headers: { "Kb-CompressionType": service.replyCompression ?? "1" },
		});

	service.fetch = async (input, init) => {
		const path = new URL(String(input)).pathname;
		const headers = (init?.headers ?? {}) as Record<string, string>;
		const body = Buffer.from(init?.body as Uint8Array);
		service.requests.push({ path, headers, body });
		if (service.hang === true) {
			// Only an abort ends this call, exactly like a real hung endpoint.
			await new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
			});
		}
		if (service.failStatus !== undefined) {
			return new Response("refused", { status: service.failStatus, headers: { error: "5011" } });
		}

		if (path === "/timestamp") return respond(varintField(1, Date.now()));

		if (path === "/oauth_pubkey_v2") {
			const fields = readFields(aes(body, BOOTSTRAP_KEY, false));
			const point = fields.get(1);
			if (!Buffer.isBuffer(point)) throw new Error("client sent no public point");
			const shared = diffieHellman({
				privateKey: keyPair.privateKey,
				publicKey: createPublicKey({
					key: Buffer.concat([header, Buffer.from(point.toString("utf8"), "hex")]),
					format: "der",
					type: "spki",
				}),
			});
			controlKey = Buffer.from(shared.toString("hex").toUpperCase());
			const reply = Buffer.concat([
				varintField(1, 0),
				bytesField(2, serverPointHex),
				bytesField(4, "gen-uin-token"),
			]);
			return respond(aes(reply, BOOTSTRAP_KEY, true));
		}

		if (controlKey === null) throw new Error(`${path} arrived before the handshake`);
		if (path === "/gen_uin_v2") {
			// The registration request must be encrypted with the derived key: a
			// wrong derivation throws here instead of silently disagreeing later.
			aes(body, controlKey, false);
			const reply = Buffer.concat([varintField(1, 0), varintField(2, 1001)]);
			return respond(aes(reply, controlKey, true));
		}

		if (path === "/api_v2") {
			inFlight += 1;
			service.peakConcurrency = Math.max(service.peakConcurrency, inFlight);
			try {
				if (options.delayMs !== undefined) {
					await new Promise((resolve) => setTimeout(resolve, options.delayMs));
				}
				const outer = readFields(aes(body, controlKey, false));
				const nested = outer.get(1);
				if (!Buffer.isBuffer(nested)) throw new Error("polish request carried no body");
				const draft = readFields(nested).get(1);
				if (!Buffer.isBuffer(draft)) throw new Error("polish request carried no text");
				const text = draft.toString("utf8");
				service.drafts.push(text);
				const arranged = options.arrange?.(text) ?? text;
				return respond(aes(bytesField(1, bytesField(1, arranged)), controlKey, true));
			} finally {
				inFlight -= 1;
			}
		}

		throw new Error(`unexpected path ${path}`);
	};

	return service;
}

// ------------------------------------------------------------------- helpers

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

function identityPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-text-polish-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return join(dir, "identity.json");
}

function provider(options: { service: FakeService; path: string; signal?: () => AbortSignal }) {
	return createTextPolishProvider({
		identityPath: () => options.path,
		fetch: options.service.fetch,
		// A handshake per provider would otherwise wait on the server clock.
		now: () => 1_700_000_000_000,
		signal: options.signal ?? (() => new AbortController().signal),
	});
}

/** A freshly minted identity is persisted once, so the assertions can read it. */
function readIdentity(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

// --------------------------------------------------------------------- tests

describe("text polish provider", () => {
	it("rewrites the whole draft through a signed, encrypted exchange", async () => {
		const service = fakeService({ arrange: (text) => `整理后：${text}` });
		const path = identityPath();
		const polish = provider({ service, path });

		expect(await polish.polish("那个，我们明天下午三点开会吧……")).toBe("整理后：那个，我们明天下午三点开会吧……");

		// The four calls of one session, in the documented order.
		expect(service.requests.map((r) => r.path)).toEqual(["/timestamp", "/oauth_pubkey_v2", "/gen_uin_v2", "/api_v2"]);
		expect(service.drafts).toEqual(["那个，我们明天下午三点开会吧……"]);

		// Every request carries the uncompressed-request and voice-scene headers
		// the endpoint requires, a body digest that matches, and a signature over
		// the documented field order plus the salt.
		for (const request of service.requests) {
			const kind = PATH_KIND[request.path];
			if (kind === undefined) throw new Error(`unknown path ${request.path}`);
			expect(request.headers["Kb-CompressionType"]).toBe("1");
			expect(request.headers["Kb-Scene"]).toBe("2");
			expect(request.headers["Kb-BodyMd5"]).toBe(md5Upper(request.body));
			const signed = SIGN_ORDER[kind].map((name) => request.headers[name]).join("") + SIGN_SALT;
			expect(request.headers["Kb-Sign"]).toBe(sha256Upper(signed));
		}
		expect(service.requests.at(-1)?.headers["Kb-CmdId"]).toBe("4549");
	});

	it("returns the draft unchanged when the service has nothing to arrange", async () => {
		const service = fakeService();
		const polish = provider({ service, path: identityPath() });
		expect(await polish.polish("已经很清楚的一句话。")).toBe("已经很清楚的一句话。");
	});

	it("mints one identity, persists it owner-only, and reuses it", async () => {
		const service = fakeService();
		const path = identityPath();
		const first = provider({ service, path });

		await first.polish("第一段");
		const identity = readIdentity(path);
		expect(identity.uin).toBe(1001);
		expect(typeof identity.private_pem).toBe("string");
		expect(statSync(path).mode & 0o777).toBe(0o600);

		// One handshake per provider: the second draft reuses the session, so the
		// task counter advances (4 → 5) but no further registration runs.
		await first.polish("第二段");
		expect(service.requests.filter((r) => r.path === "/gen_uin_v2")).toHaveLength(1);
		expect(service.requests.filter((r) => r.path === "/api_v2").at(-1)?.headers["Kb-TaskId"]).toBe("5");

		// A second provider (a restarted daemon) loads the same identity: same uin,
		// no second registration.
		const second = provider({ service, path });
		await second.polish("第三段");
		expect(service.requests.filter((r) => r.path === "/gen_uin_v2")).toHaveLength(1);
		expect(service.requests.at(-1)?.headers["Kb-Uin"]).toBe("1001");
	});

	it("never rewrites an identity file it did not mint", async () => {
		const existing = {
			device_name: "NODE-AAAA",
			private_pem: generateKeyPairSync("ec", { namedCurve: "secp128r1" })
				.privateKey.export({ type: "pkcs8", format: "pem" })
				.toString(),
			device_code: "ANDUniClipboard;res001122334455",
			uuid: "uuid-1",
			uin: 4242,
			server_key: "",
			control_key: "",
			unique_id: "",
		};
		const path = identityPath();
		writeFileSync(path, JSON.stringify(existing, null, 2), { mode: 0o600 });
		const before = readFileSync(path);

		const service = fakeService();
		const polish = provider({ service, path });
		await polish.polish("已有身份的客户端");

		// The server key and control key are per-session values; the file stays as
		// another tool left it.
		expect(readFileSync(path).equals(before)).toBe(true);
		expect(service.requests.some((r) => r.path === "/gen_uin_v2")).toBe(false);
		expect(service.requests.at(-1)?.headers["Kb-Uin"]).toBe("4242");
	});

	it("serializes drafts: one upstream exchange at a time, in order", async () => {
		const service = fakeService({ delayMs: 20 });
		const polish = provider({ service, path: identityPath() });

		const results = await Promise.all([polish.polish("一"), polish.polish("二"), polish.polish("三")]);
		expect(results).toEqual(["一", "二", "三"]);
		expect(service.drafts).toEqual(["一", "二", "三"]);
		expect(service.peakConcurrency).toBe(1);
	});

	it("reports a compressed response as a draft that is too long", async () => {
		const service = fakeService();
		service.replyCompression = "2";
		const polish = provider({ service, path: identityPath() });

		await expect(polish.polish("很长的草稿")).rejects.toThrow(/too long/i);
	});

	it("reports an HTTP refusal with the service's own code", async () => {
		const service = fakeService();
		service.failStatus = 500;
		const polish = provider({ service, path: identityPath() });

		await expect(polish.polish("草稿")).rejects.toThrow(/HTTP 500 error:5011/);
	});

	it("turns an aborted request into a timeout, not a hang", async () => {
		const service = fakeService();
		service.hang = true;
		const controller = new AbortController();
		const polish = provider({ service, path: identityPath(), signal: () => controller.signal });

		const pending = polish.polish("到时未答");
		// Abort once the request is actually in flight; the session's first call
		// runs in a microtask, so aborting immediately would precede it.
		await vi.waitFor(() => expect(service.requests.length).toBeGreaterThan(0));
		controller.abort();
		await expect(pending).rejects.toThrow(/timed out/i);
	});

	it("re-handshakes after a failure instead of staying broken", async () => {
		const service = fakeService();
		const path = identityPath();
		const polish = provider({ service, path });

		service.failStatus = 500;
		await expect(polish.polish("先失败")).rejects.toThrow(/HTTP 500/);
		service.failStatus = undefined;
		expect(await polish.polish("再成功")).toBe("再成功");
		// The failure dropped the session, so a timestamp call opens the retry.
		expect(service.requests.filter((r) => r.path === "/timestamp").length).toBeGreaterThan(1);
	});

	it("refuses a draft past the wire guard before spending a request", async () => {
		const service = fakeService();
		const polish = provider({ service, path: identityPath() });

		await expect(polish.polish("x".repeat(20_001))).rejects.toThrow(/too long/i);
		expect(service.requests).toHaveLength(0);
	});

	it("contacts nothing until a draft is polished", async () => {
		const service = fakeService();
		const fetchSpy = vi.fn(service.fetch) as unknown as typeof fetch;
		createTextPolishProvider({ identityPath: () => identityPath(), fetch: fetchSpy });
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("textPolish verb", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
	});

	it("replies with the rewritten draft and no attachment", async () => {
		const { serverWs, clientWs } = await createWsPair();
		cleanups.push(() => {
			serverWs.close();
			clientWs.close();
		});
		const frames = collectFrames(clientWs);
		const conn = new Connection(serverWs, mockDaemonVerbs, null, false);
		cleanups.push(() => conn.dispose());

		await waitForOpen(clientWs);
		clientWs.send(JSON.stringify({ id: "1", verb: "textPolish", text: "草稿" }));

		const reply = await waitForFrame(frames, (f) => (f as Record<string, unknown>).id === "1");
		expect(reply).toEqual({ id: "1", ok: true, text: "polished: 草稿" });
	});

	it("refuses an empty draft before the daemon is asked", async () => {
		const { serverWs, clientWs } = await createWsPair();
		cleanups.push(() => {
			serverWs.close();
			clientWs.close();
		});
		const frames = collectFrames(clientWs);
		const conn = new Connection(serverWs, mockDaemonVerbs, null, false);
		cleanups.push(() => conn.dispose());

		await waitForOpen(clientWs);
		clientWs.send(JSON.stringify({ id: "2", verb: "textPolish", text: "   " }));

		const reply = await waitForFrame(frames, (f) => (f as Record<string, unknown>).id === "2");
		expect(reply).toEqual({ id: "2", ok: false, error: "Missing `text`" });
	});
});
