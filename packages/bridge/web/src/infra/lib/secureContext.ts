// ============================================================================
// secureContext — detection and per-browser guidance for plain-HTTP intranets.
//
// Browsers grant a secure context only to HTTPS, localhost, and file://. An
// intranet origin served over http:// therefore loses navigator.clipboard,
// Notification permission, and service workers — which also costs app
// installation, since an installable page needs a worker — while the rest of
// the app (IndexedDB, WebSocket RPC, drafts) keeps working. The daemon has no
// TLS by design — remote access is an SSH tunnel or a reverse proxy — so the
// fixes are the browser's own origin allowlist or a localhost tunnel.
//
// The guidance is lazy: a plain-HTTP deployment is legitimate until the user
// reaches for a withheld capability. It opens at most once per browser session
// (`sessionStorage`), so repeated copy attempts never stack dialogs.
// ============================================================================

import { getStore } from "../state/store.tsx";

const SEEN_KEY = "pi-bridge:secure-context-hint";

export type BrowserFamily = "firefox" | "chromium" | "other";

/** One setting the user has to change, with the exact value for this origin. */
export interface SecureContextStep {
	/** Page to open: `about:config` or the browser's flags URL. */
	location: string;
	/** Name of the setting (the pref key or the flag's label). */
	setting: string;
	/** Value to enter for this origin. */
	value: string;
	/** How the setting reads, e.g. that its list is comma-separated. */
	note: string;
	/** Whether the browser needs a restart, not just a page reload. */
	restart: boolean;
}

export interface SecureContextGuide {
	family: BrowserFamily;
	/** Browser name used as the section heading. */
	title: string;
	/** Empty when the browser has no per-origin allowlist (Safari, iOS). */
	steps: SecureContextStep[];
}

/** True when the browser withheld secure-context APIs from this origin. */
export function isInsecureOrigin(): boolean {
	return typeof window !== "undefined" && window.isSecureContext === false;
}

function chromiumTitle(userAgent: string): string | null {
	if (/Edg\//i.test(userAgent)) return "Edge";
	if (/OPR\//i.test(userAgent)) return "Opera";
	if (/Vivaldi\//i.test(userAgent)) return "Vivaldi";
	if (/Chrom(e|ium)\//i.test(userAgent)) return "Chrome";
	return null;
}

/** Chromium browsers expose the same flag under their own `://flags` scheme. */
function flagsScheme(userAgent: string): string {
	if (/Edg\//i.test(userAgent)) return "edge";
	if (/OPR\//i.test(userAgent)) return "opera";
	if (/Vivaldi\//i.test(userAgent)) return "vivaldi";
	return "chrome";
}

/**
 * The browser-specific steps for this origin. iOS browsers are WebKit under
 * the hood (no flags page, no allowlist), so they are reported as `other`
 * even when their user agent names Chrome or Firefox.
 */
export function secureContextGuide(loc: { hostname: string; origin: string }, userAgent: string): SecureContextGuide {
	if (/FxiOS\/|CriOS\//i.test(userAgent)) {
		return { family: "other", title: "This browser", steps: [] };
	}
	if (/Firefox\/|SeaMonkey\//i.test(userAgent)) {
		return {
			family: "firefox",
			title: "Firefox",
			steps: [
				{
					location: "about:config",
					setting: "dom.securecontext.allowlist",
					value: loc.hostname,
					note: "The value is a comma-separated hostname list; add this host to it.",
					restart: false,
				},
			],
		};
	}
	const title = chromiumTitle(userAgent);
	if (title !== null) {
		return {
			family: "chromium",
			title,
			steps: [
				{
					location: `${flagsScheme(userAgent)}://flags/#unsafely-treat-insecure-origin-as-secure`,
					setting: "Insecure origins treated as secure",
					value: loc.origin,
					note: "The value is a comma-separated origin list; add this origin to it.",
					restart: true,
				},
			],
		};
	}
	return { family: "other", title: "This browser", steps: [] };
}

function hintAlreadyShown(): boolean {
	try {
		return sessionStorage.getItem(SEEN_KEY) !== null;
	} catch {
		// Storage disabled: the open flag still prevents stacking while shown.
		return false;
	}
}

function markHintShown(): void {
	try {
		sessionStorage.setItem(SEEN_KEY, "1");
	} catch {
		// Private mode: within this page load the store's open flag is enough.
	}
}

/**
 * Open the guidance when a capability was withheld. No-op on a secure origin,
 * so an ordinary permission denial is never misreported as a deployment
 * problem, and no-op once this browser session has shown it.
 */
export function noteSecureContextFailure(): void {
	if (!isInsecureOrigin()) return;
	const state = getStore().getState();
	if (state.secureContextHintOpen || hintAlreadyShown()) return;
	markHintShown();
	state.openSecureContextHint();
}
