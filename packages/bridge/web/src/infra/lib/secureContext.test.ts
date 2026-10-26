// Secure-context guidance: detection is the browser's own
// `window.isSecureContext`, the steps are browser-detected, and the hint must
// appear only for a withheld capability — never for an ordinary permission
// denial — and at most once per browser session.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStore } from "../state/store.tsx";
import { isInsecureOrigin, noteSecureContextFailure, secureContextGuide } from "./secureContext.ts";

const ORIGIN = { hostname: "10.0.0.5", origin: "http://10.0.0.5:8080" };

const FIREFOX_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0";
const CHROME_UA =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const EDGE_UA = `${CHROME_UA} Edg/129.0.0.0`;
const IOS_CHROME_UA =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1";
const SAFARI_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

function stubSessionStorage(): Map<string, string> {
	const data = new Map<string, string>();
	vi.stubGlobal("sessionStorage", {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => void data.set(key, value),
	});
	return data;
}

function hintOpen(): boolean {
	return getStore().getState().secureContextHintOpen;
}

afterEach(() => vi.unstubAllGlobals());

describe("isInsecureOrigin", () => {
	it("is true only when the browser withheld a secure context", () => {
		vi.stubGlobal("window", { isSecureContext: false });
		expect(isInsecureOrigin()).toBe(true);

		vi.stubGlobal("window", { isSecureContext: true });
		expect(isInsecureOrigin()).toBe(false);
	});
});

describe("secureContextGuide", () => {
	it("gives Firefox the pref key and the bare hostname", () => {
		const guide = secureContextGuide(ORIGIN, FIREFOX_UA);
		expect(guide.family).toBe("firefox");
		expect(guide.steps).toHaveLength(1);
		expect(guide.steps[0].location).toBe("about:config");
		expect(guide.steps[0].setting).toBe("dom.securecontext.allowlist");
		expect(guide.steps[0].value).toBe("10.0.0.5");
		expect(guide.steps[0].restart).toBe(false);
	});

	it("gives Chromium the flags URL and the full origin", () => {
		const guide = secureContextGuide(ORIGIN, CHROME_UA);
		expect(guide.family).toBe("chromium");
		expect(guide.steps[0].location).toBe("chrome://flags/#unsafely-treat-insecure-origin-as-secure");
		expect(guide.steps[0].setting).toBe("Insecure origins treated as secure");
		expect(guide.steps[0].value).toBe("http://10.0.0.5:8080");
		expect(guide.steps[0].restart).toBe(true);
	});

	it("uses the Chromium fork's own flags scheme", () => {
		expect(secureContextGuide(ORIGIN, EDGE_UA).steps[0].location).toBe(
			"edge://flags/#unsafely-treat-insecure-origin-as-secure",
		);
	});

	it("reports no allowlist for WebKit-based and unknown browsers", () => {
		for (const ua of [SAFARI_UA, IOS_CHROME_UA, ""]) {
			const guide = secureContextGuide(ORIGIN, ua);
			expect(guide.family).toBe("other");
			expect(guide.steps).toHaveLength(0);
		}
	});
});

describe("noteSecureContextFailure", () => {
	beforeEach(() => {
		getStore().getState().closeSecureContextHint();
		stubSessionStorage();
		vi.stubGlobal("window", { isSecureContext: false, location: ORIGIN });
	});

	afterEach(() => getStore().getState().closeSecureContextHint());

	it("opens the hint on an insecure origin", () => {
		noteSecureContextFailure();
		expect(hintOpen()).toBe(true);
	});

	it("opens it at most once per browser session", () => {
		noteSecureContextFailure();
		getStore().getState().closeSecureContextHint();
		noteSecureContextFailure();
		expect(hintOpen()).toBe(false);
	});

	it("does not stack while the hint is open", () => {
		noteSecureContextFailure();
		expect(globalThis.sessionStorage.getItem("pi-bridge:secure-context-hint")).toBe("1");
		noteSecureContextFailure();
		expect(hintOpen()).toBe(true);
	});

	it("stays silent on a secure origin", () => {
		vi.stubGlobal("window", { isSecureContext: true, location: ORIGIN });
		noteSecureContextFailure();
		expect(hintOpen()).toBe(false);
		expect(globalThis.sessionStorage.getItem("pi-bridge:secure-context-hint")).toBeNull();
	});
});
