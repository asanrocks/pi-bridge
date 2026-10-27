/// <reference lib="dom" />

/**
 * Demo page: one `Dictation` over a real `<textarea>`.
 *
 * Imports name the package, never a compiled file: the page's import map is the
 * single place that says where those entries live, so renaming an export fails
 * `tsc` here instead of failing in a browser.
 *
 * The interesting part is how little wiring there is. The library composes
 * `openMicrophone` → `AsrSession.push` → `text` events → `DictationEdit` →
 * `attachInput`; the page supplies credentials, a host, and a button to style.
 * Compare with the hand-rolled version this replaced: same behaviour, none of
 * the lifecycle bookkeeping.
 */
import { bindButton, Dictation } from "@earendil-works/pi-asr/dictation";
import { attachInput } from "@earendil-works/pi-asr/dom";

function required<T>(element: T | null): T {
	if (element === null) throw new Error("demo: the page is missing an element this script needs");
	return element;
}

const field = required(document.querySelector<HTMLTextAreaElement>("#field"));
const button = required(document.querySelector<HTMLButtonElement>("#mic"));
const status = required(document.querySelector<HTMLElement>("#status"));
const log = required(document.querySelector<HTMLElement>("#log"));

function setStatus(text: string, tone: "idle" | "busy" | "ok" | "error" = "idle"): void {
	status.textContent = text;
	status.dataset.tone = tone;
}

/** Either a minted SAMI token or a registered device: the server decides which. */
type Credentials = { token: string } | { deviceId: string };

async function credentials(): Promise<Credentials> {
	const response = await fetch("/credentials");
	const body: unknown = await response.json().catch(() => ({}));
	if (!response.ok) {
		const detail = typeof body === "object" && body !== null && "error" in body ? String(body.error) : "";
		throw new Error(detail === "" ? `credentials: HTTP ${String(response.status)}` : detail);
	}
	if (typeof body === "object" && body !== null && "token" in body) {
		return { token: String(body.token) };
	}
	if (typeof body === "object" && body !== null && "deviceId" in body) {
		return { deviceId: String(body.deviceId) };
	}
	throw new Error("credentials: unexpected payload");
}

/**
 * A page cannot set request headers, so the JSON wire is the only option, and it
 * cannot register a device either — the local server does both. Minting per
 * utterance keeps the token lifetime inside the session lifetime; the demo
 * server caches the credential, so the round trip is local.
 */
const creds = await credentials();

const auth =
	"token" in creds
		? {
				// Re-mint before every utterance: the token is a bearer credential and
				// the page never keeps one longer than a session.
				getToken: async (): Promise<string> => {
					const next = await credentials();
					if (!("token" in next)) throw new Error("demo: the server stopped minting tokens");
					return next.token;
				},
			}
		: { device: { deviceId: creds.deviceId } };

const target = attachInput(field);
const dictation = new Dictation({
	session: { wire: "json", auth },
	host: target,
	// `auto` (the default) holds on touch and latches on a mouse; the demo is
	// opened on both, so it should not have to choose.
	mic: { audio: { echoCancellation: false, noiseSuppression: true } },
});

bindButton(button, dictation);

dictation.subscribe((phase) => {
	if (phase.kind === "preparing") {
		setStatus("waiting for the microphone…", "busy");
		return;
	}
	if (phase.kind === "listening") {
		// Capture is live the moment audio arrives; `sending` only says whether the
		// handshake has finished, so the status must not wait for it.
		setStatus(phase.sending ? "recording" : "recording — still connecting…", "busy");
		return;
	}
	if (phase.kind === "committing") {
		setStatus("finishing…", "busy");
		return;
	}
	if (phase.kind === "failed") {
		setStatus(`${phase.error.code}: ${phase.error.message}`, "error");
		return;
	}
	// The session ended on its own, typically after ~20 s without audio. That is a
	// normal outcome, so the text stayed and only the reason is worth a line.
	const reason = dictation.result.error;
	setStatus("idle", reason === null ? "ok" : "error");
	if (reason !== null) log.append(`\n[${reason.code}] ${reason.message}`);
});

field.focus();
field.setSelectionRange(field.value.length, field.value.length);
