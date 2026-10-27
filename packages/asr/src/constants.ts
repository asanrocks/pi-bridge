/**
 * Fixed endpoint details, verified against the live service and documented in
 * `docs/protocol.md`. All of them are unofficial: the endpoints are private and
 * the app key is baked into the official IME, not issued to us.
 */

/** Streaming ASR endpoint. Wire format is chosen by the `proto-version` header. */
export const ASR_URL = "wss://frontier-audio-ime-ws.doubao.com/ocean/api/v1/ws";

/** SAMI token endpoint. Needs `X-Api-Access-Key`; no CORS, so server-side only. */
export const TOKEN_URL = "https://ime.oceancloudapi.com/api/v1/user/get_config";

/** Device self-registration. Unauthenticated, and equally without CORS. */
export const DEVICE_REGISTER_URL = "https://log-klink.zijieapi.com/service/2/device_register/";

/** App key baked into the official IME; sent as `appkey` and as the token on the device path. */
export const ASR_APP_KEY = "OrnqKvSSrs";

/** App id the endpoint wants alongside a `device_id`. */
export const ASR_AID = 401734;

/** Sample rate the service expects. Fixed. */
export const SAMPLE_RATE = 16_000;

/** Header that switches the connection to the protobuf wire format. */
export const PROTO_VERSION_HEADER = "proto-version";

/** The only value the server has been observed to honour. */
export const PROTO_VERSION_VALUE = "v2";

/** Custom headers the official clients send on the protobuf wire. */
export const KEEPALIVE_HEADER = "x-custom-keepalive";

/** User agent the official Android IME sends; device registration validates against it. */
export const IME_USER_AGENT =
	"com.bytedance.android.doubaoime/100307013 (Linux; U; Android 16; en_US; " +
	"Pixel 7 Pro; Build/BP2A.250605.031.A2; Cronet/TTNetVersion:94cf429a 2025-11-17 " +
	"QuicVersion:1f89f732 2025-05-08)";
