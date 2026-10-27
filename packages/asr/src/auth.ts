/**
 * Credential resolution.
 *
 * The three shapes exist because the endpoint has three: a SAMI token (minted
 * server-side, no query), the fixed app key plus a registered `device_id` in
 * the query string, and anything a caller wants to inject (relay, extension).
 * See `docs/protocol.md` §1.2 for the verified combinations.
 */
import { ASR_AID, ASR_APP_KEY } from "./constants.ts";
import { AsrError } from "./errors.ts";
import type { Auth } from "./types.ts";

export interface ResolvedAuth {
	token: string;
	query: Readonly<Record<string, string>>;
}

export async function resolveAuth(auth: Auth): Promise<ResolvedAuth> {
	let token: string;
	let query: Record<string, string> = {};

	if ("token" in auth) {
		token = auth.token;
	} else if ("getToken" in auth) {
		token = await auth.getToken();
	} else {
		token = ASR_APP_KEY;
		query = { aid: String(ASR_AID), device_id: auth.device.deviceId };
	}

	if (token.length === 0) {
		throw new AsrError("config", "auth: the resolved token is empty");
	}
	return { token, query };
}

/** Append auth query parameters, if any, to the endpoint URL. */
export function withQuery(url: string, query: Readonly<Record<string, string>>): string {
	const entries = Object.entries(query);
	if (entries.length === 0) return url;
	const parsed = new URL(url);
	for (const [key, value] of entries) parsed.searchParams.set(key, value);
	return parsed.toString();
}
