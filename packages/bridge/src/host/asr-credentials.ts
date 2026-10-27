// ============================================================================
// ASR credentials — the one thing a page cannot obtain for itself.
//
// A browser cannot mint a Doubao SAMI token (the token endpoint sends no CORS
// headers and needs a real secret) and cannot register a device either (that
// endpoint sends no CORS headers). So dictation credentials are a daemon
// concern, handed to the page over the existing RPC channel.
//
// Two acceptable shapes, exactly as `docs/protocol.md` §1.3/§1.4 in pi-asr
// describes them:
//
//   - A registered `device_id` is a *shared, non-secret* identity, so it is the
//     default: dictation then works with no configuration at all. Cached for the
//     process because registration is a network round trip and the value never
//     expires.
//   - `DOUBAO_ACCESS_KEY` in the daemon environment enables SAMI tokens, which
//     an operator may prefer because they are per-deployment rather than the
//     shared IME identity. The key never leaves this process; only the minted
//     token does, and it is cached until shortly before it is due.
//
// Both failures are reported as RPC errors and retried on the next request: a
// provider that remembers a failure would leave dictation broken for the life
// of the daemon.
// ============================================================================

import { type MintedToken, mintSamiToken, registerDevice } from "@earendil-works/pi-asr/node";
import type { AsrCredential } from "../core/index.ts";

/** Refresh a minted token this long before its advisory expiry. The server is
 * the authority on expiry, so this only has to beat the advisory clock. The web
 * composer schedules its own refresh inside this window (a shorter margin, see
 * `web/src/features/composer/dictationPolicy.ts`), so a request from a tab always
 * mints a replacement rather than handing back this cached token. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

export interface AsrCredentialOptions {
	/** Defaults to `DOUBAO_ACCESS_KEY` from the daemon environment. */
	accessKey?: string | undefined;
	/** Test seams, mirroring the package's own injection points. */
	register?: () => Promise<{ deviceId: string }>;
	mint?: (options: { accessKey: string }) => Promise<MintedToken>;
	now?: () => number;
}

export interface AsrCredentialProvider {
	get: () => Promise<AsrCredential>;
}

export function createAsrCredentialProvider(options: AsrCredentialOptions = {}): AsrCredentialProvider {
	const accessKey = options.accessKey ?? process.env.DOUBAO_ACCESS_KEY;
	const register = options.register ?? (() => registerDevice());
	const mint = options.mint ?? ((mintOptions) => mintSamiToken(mintOptions));
	const now = options.now ?? Date.now;

	let deviceId: string | undefined;
	let token: MintedToken | undefined;
	/** Collapses concurrent requests: two tabs opening at once must not
	 * register twice or mint two tokens. Cleared on failure, so a retry is a
	 * fresh attempt rather than the settled rejection. */
	let inflight: Promise<AsrCredential> | undefined;

	const load = async (): Promise<AsrCredential> => {
		if (accessKey !== undefined && accessKey.length > 0) {
			if (token === undefined || now() >= token.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
				token = await mint({ accessKey });
			}
			return { kind: "token", token: token.token, expiresAt: token.expiresAt };
		}
		if (deviceId === undefined) {
			deviceId = (await register()).deviceId;
		}
		return { kind: "device", deviceId };
	};

	return {
		get: () => {
			if (inflight === undefined) {
				inflight = load().finally(() => {
					inflight = undefined;
				});
			}
			return inflight;
		},
	};
}
