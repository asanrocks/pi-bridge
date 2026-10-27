/**
 * Device self-registration (Node only).
 *
 * The endpoint takes no credential at all, but it does send a device
 * fingerprint, so treat it as an acceptable bootstrap rather than a place to
 * hide anything: the `device_id` it returns is a *shared* identity, not a
 * per-user one. `docs/protocol.md` §1.4 records the measured request.
 *
 * Registration is cheap (~300 ms) and the result is not secret, so callers are
 * expected to cache it themselves; this module keeps no state.
 */
import { ASR_AID, DEVICE_REGISTER_URL, IME_USER_AGENT } from "./constants.ts";
import { AsrError } from "./errors.ts";
import { isJsonObject, readNumber, readString } from "./json.ts";
import type { DeviceCredentials } from "./types.ts";

const VERSION_CODE = "100307013";
const VERSION_NAME = "1.3.7";

export interface RegisterDeviceOptions {
	/** Injected in tests; defaults to the global `fetch`. */
	fetch?: typeof globalThis.fetch;
	url?: string;
	userAgent?: string;
	now?: () => number;
}

export async function registerDevice(options: RegisterDeviceOptions = {}): Promise<DeviceCredentials> {
	const doFetch = options.fetch ?? globalThis.fetch;
	const now = options.now ?? Date.now;
	const cdid = crypto.randomUUID();
	const clientudid = crypto.randomUUID();
	const openudid = randomHex(8);

	const params = new URLSearchParams({
		device_platform: "android",
		os: "android",
		ssmix: "a",
		_rticket: String(now()),
		cdid,
		channel: "official",
		aid: String(ASR_AID),
		app_name: "oime",
		version_code: VERSION_CODE,
		version_name: VERSION_NAME,
		manifest_version_code: VERSION_CODE,
		update_version_code: VERSION_CODE,
		resolution: "1080*2400",
		dpi: "420",
		device_type: "Pixel 7 Pro",
		device_brand: "google",
		language: "zh",
		os_api: "34",
		os_version: "16",
		ac: "wifi",
	});

	const response = await doFetch(`${options.url ?? DEVICE_REGISTER_URL}?${params.toString()}`, {
		method: "POST",
		headers: {
			"User-Agent": options.userAgent ?? IME_USER_AGENT,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(buildBody({ cdid, openudid, clientudid, now: now() })),
		// The request carries device identifiers, so a redirect must fail instead of
		// forwarding them to another origin.
		redirect: "manual",
	});

	const text = await response.text();
	if (!response.ok) {
		throw new AsrError("connection", `registerDevice: HTTP ${String(response.status)}: ${text.slice(0, 200)}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new AsrError("connection", "registerDevice: response is not JSON", { cause: error });
	}
	if (!isJsonObject(parsed)) {
		throw new AsrError("connection", "registerDevice: response is not an object");
	}

	// `device_id` arrives as a number, but has been seen as a decimal string and
	// can exceed what a double prints exactly, so both shapes are accepted.
	const deviceId = readNumber(parsed, "device_id")?.toFixed(0) ?? readString(parsed, "device_id_str") ?? "";
	if (deviceId.length === 0 || deviceId === "0") {
		throw new AsrError("connection", "registerDevice: no device_id in the response");
	}

	const installId = readNumber(parsed, "install_id")?.toFixed(0);
	return installId === undefined ? { deviceId } : { deviceId, installId };
}

function buildBody(input: {
	cdid: string;
	openudid: string;
	clientudid: string;
	now: number;
}): Record<string, unknown> {
	return {
		magic_tag: "ss_app_log",
		header: {
			device_id: 0,
			install_id: 0,
			aid: ASR_AID,
			app_name: "oime",
			version_code: Number(VERSION_CODE),
			version_name: VERSION_NAME,
			manifest_version_code: Number(VERSION_CODE),
			update_version_code: Number(VERSION_CODE),
			channel: "official",
			package: "com.bytedance.android.doubaoime",
			device_platform: "android",
			os: "android",
			os_api: "34",
			os_version: "16",
			device_type: "Pixel 7 Pro",
			device_brand: "google",
			device_model: "Pixel 7 Pro",
			resolution: "1080*2400",
			dpi: "420",
			language: "zh",
			timezone: 8,
			access: "wifi",
			rom: "UP1A.231005.007",
			rom_version: "UP1A.231005.007",
			region: "CN",
			tz_name: "Asia/Shanghai",
			tz_offset: 28800,
			sim_region: "cn",
			carrier_region: "cn",
			cpu_abi: "arm64-v8a",
			build_serial: "unknown",
			not_request_sender: 0,
			sig_hash: "",
			google_aid: "",
			mc: "",
			serial_number: "",
			openudid: input.openudid,
			clientudid: input.clientudid,
			cdid: input.cdid,
		},
		_gen_time: input.now,
	};
}

function randomHex(bytes: number): string {
	const buffer = new Uint8Array(bytes);
	crypto.getRandomValues(buffer);
	return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
