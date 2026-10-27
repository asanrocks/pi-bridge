/**
 * SAMI token minting, for the server side only.
 *
 * The token endpoint sends no CORS headers and authenticates with a real secret
 * (`X-Api-Access-Key`), so a page can never call it. What a page receives is the
 * token, which is an unbound bearer credential valid for hours: mint per user,
 * record issuance, and keep it in memory (`docs/protocol.md` §1.3).
 */
import { ASR_APP_KEY, TOKEN_URL } from "./constants.ts";
import { AsrError } from "./errors.ts";
import { isJsonObject, readNumber, readObject, readString } from "./json.ts";

/** The service issues ~24 h tokens and returns no expiry, so the TTL is advisory. */
export const DEFAULT_TOKEN_TTL_MS = 5 * 60 * 60 * 1000;

export interface MintTokenOptions {
	accessKey: string;
	appKey?: string;
	url?: string;
	fetch?: typeof globalThis.fetch;
	requestId?: string;
	/** Advisory lifetime used for {@link MintedToken.expiresAt}. */
	ttlMs?: number;
	now?: () => number;
}

export interface MintedToken {
	token: string;
	/** Wall-clock ms after which the caller should mint a new one, at a session boundary. */
	expiresAt: number;
}

export async function mintSamiToken(options: MintTokenOptions): Promise<MintedToken> {
	if (options.accessKey.length === 0) {
		throw new AsrError("config", "mintSamiToken: an access key is required");
	}
	const doFetch = options.fetch ?? globalThis.fetch;

	const response = await doFetch(options.url ?? TOKEN_URL, {
		method: "POST",
		headers: {
			"User-Agent": "DoubaoIme/1.0.0",
			"Content-Type": "application/json",
			"X-Api-Access-Key": options.accessKey,
			"X-Api-Request-Id": options.requestId ?? crypto.randomUUID(),
		},
		body: JSON.stringify({ sami_app_key: options.appKey ?? ASR_APP_KEY }),
	});

	const text = await response.text();
	if (!response.ok) {
		throw new AsrError("connection", `mintSamiToken: HTTP ${String(response.status)}: ${text.slice(0, 200)}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new AsrError("connection", "mintSamiToken: response is not JSON", { cause: error });
	}

	const code = isJsonObject(parsed) ? readNumber(parsed, "Code") : undefined;
	const data = isJsonObject(parsed) ? readObject(parsed, "Data") : undefined;
	const token = data === undefined ? undefined : readString(data, "sami_token");
	if (code !== 0 || token === undefined || token.length === 0) {
		throw new AsrError("auth_expired", `mintSamiToken: unexpected response ${text.slice(0, 200)}`);
	}
	const now = options.now ?? Date.now;
	return { token, expiresAt: now() + (options.ttlMs ?? DEFAULT_TOKEN_TTL_MS) };
}
