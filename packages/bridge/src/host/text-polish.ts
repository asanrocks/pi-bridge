// ============================================================================
// text polish — WeChat IME `Kb-CmdId: 4549`, spoken by the daemon.
//
// A page cannot speak this protocol: it needs AES-256-ECB, `secp128r1` ECDH,
// MD5 body digests and SHA-256 signatures, and the endpoint sends no CORS
// headers. So the daemon owns the whole exchange — the client sends the draft
// as text and receives rewritten text back.
//
// This is the one bridge path that hands user text to a third party, so the
// press is the whole consent story: the control that triggers it says so in its
// tooltip, nothing is polished in the background, and remembering the answer
// (the toolbar's undo) is what stops a second press from being needed.
//
// This is a *different service* from the ASR endpoint: nothing here imports
// pi-asr, and pi-asr's `./node` entry knows nothing about it. The wire facts are
// ported from the upstream probe `tools/wxime-text-polish.mjs`, which stays the
// authority for them; what is added here is only what a daemon needs — an abort
// timeout, one request at a time, and an identity persisted where a daemon may
// write.
//
// Scope is one request and one response: no streaming, no polish history
// (`source_text_list` carries the draft alone, so the server rewrites exactly
// it), and no snappy. Requests go out uncompressed, which the server accepts; a
// compressed *response* means the input was too long and is reported as such
// rather than mangled.
// ============================================================================

import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createPrivateKey,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	randomBytes,
	randomUUID,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Override for the guest identity file; the daemon supplies the default. */
export const TEXT_POLISH_IDENTITY_ENV = "BRIDGE_TEXT_POLISH_IDENTITY";

const HOST = "https://wetype.weixin.qq.com";
const VERSION = "4.0.0.58119";
const SYSTEM_VERSION = "34";
/** `libime_net.so` `.rodata`; appended to every signature string and to `device_code`. */
const SIGN_SALT = "aI0wC6qT1nB3nN5r";
/** Encrypts only the two handshake endpoints, before a control key exists. */
const BOOTSTRAP_KEY = Buffer.from("G7E1C8B0D7D7E4L3J2U9D6W0B2M8Q6O5");
const CMD_DH = 0x7ffffffe;
const CMD_GEN_UIN = 0x7ffffffd;
const CMD_TEXT_POLISH = 4549;

/** The upstream limit is unknown — a compressed response is how it refuses a
 * long draft — so the client refuses absurd payloads before spending a request
 * and a rate-limit budget on them. */
const MAX_TEXT_LENGTH = 20_000;

/** A polish that has not answered by now is not going to: the composer has
 * locked its field for the round trip, and the toolbar needs an answer. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Signing order is protocol, not declaration order; the salt always trails. */
const SIGN_ORDER = {
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
} as const;

/** The guest identity the service accepts without a login. Field names are the
 * upstream JSON, so a file written by the probe remains usable here. */
export interface TextPolishIdentity {
	device_name: string;
	private_pem: string;
	device_code: string;
	uuid: string;
	uin: number;
	server_key: string;
	control_key: string;
	unique_id: string;
}

/** A failure whose message is written for the composer's toolbar, not for a log:
 * the reason a polish attempt ended is what the user is told. */
export class TextPolishError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TextPolishError";
	}
}

// ------------------------------------------------------------------ protobuf

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

function varintField(field: number, value: number): Buffer {
	return Buffer.concat([varint(field << 3), varint(value)]);
}

function bytesField(field: number, value: string | Buffer): Buffer {
	const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
	return Buffer.concat([varint((field << 3) | 2), varint(bytes.length), bytes]);
}

function readVarint(buf: Buffer, pos: number): [value: number, next: number] {
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

/** Flat decode: enough for these messages, which nest by at most one level. */
function readFields(buf: Buffer): Map<number, number | Buffer> {
	const out = new Map<number, number | Buffer>();
	let pos = 0;
	while (pos < buf.length) {
		const [tag, afterTag] = readVarint(buf, pos);
		pos = afterTag;
		const field = tag >> 3;
		const wire = tag & 7;
		if (wire === 0) {
			const [value, next] = readVarint(buf, pos);
			out.set(field, value);
			pos = next;
		} else if (wire === 2) {
			const [length, start] = readVarint(buf, pos);
			out.set(field, buf.subarray(start, start + length));
			pos = start + length;
		} else {
			throw new TextPolishError(`Text polish: unsupported protobuf wire type ${wire} at field ${field}`);
		}
	}
	return out;
}

// -------------------------------------------------------------------- crypto

function aesEcb(data: Buffer, key: Buffer, encrypt: boolean): Buffer {
	const cipher = encrypt ? createCipheriv("aes-256-ecb", key, null) : createDecipheriv("aes-256-ecb", key, null);
	return Buffer.concat([cipher.update(data), cipher.final()]);
}

const md5Upper = (data: Buffer): string => createHash("md5").update(data).digest("hex").toUpperCase();
const sha256Upper = (data: string): string => createHash("sha256").update(data).digest("hex").toUpperCase();

function newIdentity(): TextPolishIdentity {
	// Device code is self-asserted: "AND" + 17 chars + 12 hex, then its own salted
	// digest.
	const keyPair = generateKeyPairSync("ec", { namedCurve: "secp128r1" });
	const prefix = `AND${"UniClipboard;research".slice(0, 17)}${randomBytes(6).toString("hex")}`;
	return {
		device_name: `NODE-${randomBytes(2).toString("hex").toUpperCase()}`,
		private_pem: keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
		device_code: prefix + md5Upper(Buffer.from(prefix + SIGN_SALT, "utf8")),
		uuid: randomUUID(),
		uin: 0,
		server_key: "",
		control_key: "",
		unique_id: "",
	};
}

/** The file carries a private key, so it is only ever overwritten by the
 * identity that just registered: a file that already exists is read and left
 * alone (byte-identical), which is what lets another tool own it. */
function loadIdentity(path: string): { identity: TextPolishIdentity; existing: boolean } {
	try {
		return { identity: JSON.parse(readFileSync(path, "utf8")) as TextPolishIdentity, existing: true };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return { identity: newIdentity(), existing: false };
}

function persistIdentity(path: string, identity: TextPolishIdentity): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(identity, null, 2), { mode: 0o600 });
}

/** SPKI DER tail minus the curve header: the 33-byte uncompressed point as
 * uppercase HEX. */
function publicPointHex(identity: TextPolishIdentity): string {
	const der = createPublicKey(createPrivateKey(identity.private_pem)).export({ type: "spki", format: "der" });
	return der
		.subarray(der.length - 33)
		.toString("hex")
		.toUpperCase();
}

/** The 16-byte ECDH secret, upsized to 32 ASCII chars by upper-casing its hex. */
function deriveControlKey(identity: TextPolishIdentity): string {
	const privateKey = createPrivateKey(identity.private_pem);
	const header = createPublicKey(privateKey).export({ type: "spki", format: "der" }).subarray(0, -33);
	const peer = Buffer.from(identity.server_key, "hex");
	if (peer.length !== 33 || peer[0] !== 0x04) throw new TextPolishError("Text polish: server key is not a point");
	const shared = diffieHellman({
		privateKey,
		publicKey: createPublicKey({ key: Buffer.concat([header, peer]), format: "der", type: "spki" }),
	});
	if (shared.length !== 16) throw new TextPolishError(`Text polish: expected a 16-byte secret, got ${shared.length}`);
	// Uppercased hex of the 16-byte secret: the service's key is 32 ASCII chars.
	return shared.toString("hex").toUpperCase();
}

// ----------------------------------------------------------------- transport

type SignKind = keyof typeof SIGN_ORDER;

interface Transport {
	/** Server clock offset, learned from `/timestamp`. */
	setOffset: (offset: number) => void;
	call: (path: string, body: Buffer, headers: Record<string, string>, kind: SignKind) => Promise<Buffer>;
}

function createTransport(input: { fetch: typeof fetch; now: () => number; signal: () => AbortSignal }): Transport {
	const state = { task: 1, offset: 0 };

	return {
		setOffset: (offset) => {
			state.offset = offset;
		},
		call: async (path, body, headers, kind) => {
			const common: Record<string, string> = {
				"Kb-OsType": "1",
				"Kb-Version": VERSION,
				"Kb-SystemVersion": SYSTEM_VERSION,
				"Kb-PackageType": "1",
				"Kb-TimeStamp": String(input.now() + state.offset),
				"Kb-BodyMd5": md5Upper(body),
				"Kb-TraceId": randomBytes(8).toString("hex"),
				"Kb-TaskId": String(state.task++),
				// The voice process (`:hld`) sends 2; anything else is rejected with 5011.
				"Kb-Scene": "2",
				// Uncompressed request. The server accepts 1 for this command, which is
				// what lets the client skip a snappy encoder.
				"Kb-CompressionType": "1",
				"Content-Type": "application/octet-stream",
				Use_DebugNet: "0",
				...headers,
			};
			const signed = {
				...common,
				"Kb-Sign": sha256Upper(SIGN_ORDER[kind].map((name) => common[name]).join("") + SIGN_SALT),
			};

			const response = await input.fetch(HOST + path, {
				method: "POST",
				body: new Uint8Array(body),
				headers: signed,
				signal: input.signal(),
			});
			const raw = Buffer.from(await response.arrayBuffer());
			if (response.status !== 200) {
				const code = response.headers.get("error") ?? "?";
				throw new TextPolishError(
					`Text polish unavailable: HTTP ${response.status} error:${code} ${raw.toString("utf8", 0, 200)}`.trim(),
				);
			}
			const compression = response.headers.get("Kb-CompressionType") ?? "1";
			if (compression !== "1") {
				throw new TextPolishError("The draft is too long to polish. Shorten it and try again.");
			}
			return raw;
		},
	};
}

const deviceInfo = (identity: TextPolishIdentity): string =>
	`UniClipboard;research;standalone;${identity.device_name};sdk ${SYSTEM_VERSION};PHONE`;

function handshakeHeaders(identity: TextPolishIdentity, key: Buffer, cmd: number): Record<string, string> {
	return {
		"Kb-DeviceCodeRestrictionV2": "1",
		"Kb-Uin": String(identity.uin),
		"Kb-CmdId": String(cmd),
		"Kb-SubCmdId": "0",
		// The key suffix is a byte range, not a decoded string; both keys are
		// ASCII, so this is the same four bytes the probe sends.
		"Kb-SharedKeySuffix": key.subarray(-4).toString("latin1"),
	};
}

/** Bootstraps the server clock, a control key and — for a fresh identity — a
 * guest `uin`. Idempotent for an identity that already registered. */
async function handshake(transport: Transport, identity: TextPolishIdentity): Promise<void> {
	const stamp = readFields(await transport.call("/timestamp", Buffer.alloc(0), {}, "timestamp"));
	transport.setOffset(Number(stamp.get(1)) - Date.now());

	const body = Buffer.concat([
		bytesField(1, publicPointHex(identity)),
		bytesField(2, identity.server_key),
		varintField(3, identity.uin === 0 ? 1 : 0),
		bytesField(4, identity.device_code),
		varintField(5, identity.uin),
		bytesField(6, ""),
		bytesField(7, ""),
		bytesField(8, deviceInfo(identity)),
		bytesField(9, identity.device_name),
	]);
	const reply = readFields(
		aesEcb(
			await transport.call(
				"/oauth_pubkey_v2",
				aesEcb(body, BOOTSTRAP_KEY, true),
				handshakeHeaders(identity, BOOTSTRAP_KEY, CMD_DH),
				"ecdh",
			),
			BOOTSTRAP_KEY,
			false,
		),
	);
	if (Number(reply.get(1)) !== 0) throw new TextPolishError(`Text polish: handshake status ${reply.get(1)}`);
	const serverKey = reply.get(2);
	if (!Buffer.isBuffer(serverKey)) throw new TextPolishError("Text polish: handshake carried no server key");
	identity.server_key = serverKey.toString();
	identity.control_key = deriveControlKey(identity);
	if (identity.uin !== 0) return;

	const token = reply.get(4);
	const genUinToken = Buffer.isBuffer(token) ? token.toString() : "";
	if (genUinToken === "") {
		throw new TextPolishError("Text polish: the service refused to register this client");
	}
	const controlKey = Buffer.from(identity.control_key);
	const register = Buffer.concat([
		bytesField(1, identity.device_code),
		bytesField(2, identity.server_key),
		bytesField(4, identity.unique_id || identity.uuid),
		bytesField(5, ""),
	]);
	const registered = readFields(
		aesEcb(
			await transport.call(
				"/gen_uin_v2",
				aesEcb(register, controlKey, true),
				{ ...handshakeHeaders(identity, controlKey, CMD_GEN_UIN), "Kb-GenUinToken": genUinToken },
				"register",
			),
			controlKey,
			false,
		),
	);
	const uin = Number(registered.get(2));
	if (Number(registered.get(1)) !== 0 || uin === 0) {
		throw new TextPolishError("Text polish: the service refused to register this client");
	}
	identity.uin = uin;
}

/**
 * `TextPolishReq` inside `ImeVoiceTranslateReq.voiceData`. `source_text_list` is
 * the polish history followed by the text to arrange, and the server rewrites
 * only the last entry — so one field carries the draft and the whole answer
 * replaces it. `hasAsr`/`sourceType` are the client's own hints; a composer
 * draft is neither typed in a WeChat field nor recognised by IME speech, so both
 * stay at 0.
 */
function polishBody(text: string): Buffer {
	const parts = [
		bytesField(1, text),
		varintField(2, 1),
		varintField(3, 0),
		varintField(4, 0),
		bytesField(5, "com.tencent.wetype"),
		varintField(6, 0),
	];
	return bytesField(1, Buffer.concat(parts));
}

function parsePolishReply(plain: Buffer): string {
	const outer = readFields(plain);
	const nested = outer.get(1);
	const inner = Buffer.isBuffer(nested) && nested.length > 0 ? readFields(nested) : outer;
	const arranged = inner.get(1);
	return Buffer.isBuffer(arranged) ? arranged.toString("utf8") : "";
}

// ------------------------------------------------------------------- session

interface Session {
	identity: TextPolishIdentity;
	transport: Transport;
}

// ------------------------------------------------------------------- provider

export interface TextPolishOptions {
	/** Absolute path of the guest identity file, resolved lazily: the daemon
	 * knows its agent directory only after it starts. */
	identityPath: () => string;
	/** Test seams; production uses the platform `fetch`, `Date.now` and a
	 * timeout signal. */
	fetch?: typeof fetch | undefined;
	now?: (() => number) | undefined;
	signal?: (() => AbortSignal) | undefined;
}

export interface TextPolishProvider {
	/** Rewrite one draft. Serialized: one upstream exchange at a time. */
	polish: (text: string) => Promise<string>;
}

export function createTextPolishProvider(options: TextPolishOptions): TextPolishProvider {
	const doFetch = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	const signal = options.signal ?? (() => AbortSignal.timeout(DEFAULT_TIMEOUT_MS));

	/** One exchange at a time: the service rate-limits a `uin`, and the task
	 * counter belongs to one connection. A second draft waits instead of racing,
	 * so answers cannot arrive swapped. */
	let queue: Promise<unknown> = Promise.resolve();
	/** Null until the first successful handshake, and null again after any
	 * failure: a stale clock offset or control key is the likeliest cause, so the
	 * next attempt redoes the handshake rather than failing forever. */
	let session: Session | null = null;

	const ensureSession = async (): Promise<Session> => {
		if (session !== null) return session;
		const path = options.identityPath();
		const loaded = loadIdentity(path);
		const identity = loaded.identity;
		const uinBefore = identity.uin;
		const transport = createTransport({ fetch: doFetch, now, signal });
		await handshake(transport, identity);
		// A freshly minted identity, or one that just registered, is worth keeping:
		// the alternative re-registers a guest `uin` on every daemon restart.
		if (!loaded.existing || identity.uin !== uinBefore) persistIdentity(path, identity);
		session = { identity, transport };
		return session;
	};

	const run = async (text: string): Promise<string> => {
		if (text.length > MAX_TEXT_LENGTH) {
			throw new TextPolishError("The draft is too long to polish. Shorten it and try again.");
		}
		try {
			const live = await ensureSession();
			const controlKey = Buffer.from(live.identity.control_key);
			const plain = aesEcb(
				await live.transport.call(
					"/api_v2",
					aesEcb(polishBody(text), controlKey, true),
					handshakeHeaders(live.identity, controlKey, CMD_TEXT_POLISH),
					"api",
				),
				controlKey,
				false,
			);
			const arranged = parsePolishReply(plain);
			if (arranged === "") throw new TextPolishError("Text polish returned nothing. Try again.");
			return arranged;
		} catch (error) {
			session = null;
			throw asPolishError(error);
		}
	};

	return {
		polish: (text) => {
			const result = queue.then(() => run(text));
			queue = result.catch(() => undefined);
			return result;
		},
	};
}

/** An aborted request is a timeout in this feature's vocabulary: the composer
 * locked the field for a round trip that is over either way. */
function asPolishError(error: unknown): Error {
	if (error instanceof TextPolishError) return error;
	const name = error instanceof Error ? error.name : "";
	if (name === "AbortError" || name === "TimeoutError") {
		return new TextPolishError("Text polish timed out. Try again.");
	}
	const message = error instanceof Error ? error.message : String(error);
	return new TextPolishError(`Text polish failed: ${message}`);
}
