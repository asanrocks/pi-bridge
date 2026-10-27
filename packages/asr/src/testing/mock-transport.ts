/**
 * Transport double and frame builders, published as `@earendil-works/pi-asr/testing`.
 *
 * A host that embeds this package has to test its own orchestration without a
 * socket, and the only honest way to do that is to push captured server frames
 * through the real session. Shipping these doubles is what keeps that host from
 * writing its own approximation of the wire.
 *
 * Everything here is offline by construction, and it is the only source file
 * allowed to know both wire formats at once.
 */
import type { Transport, TransportMessage } from "../transport.ts";

export class MockTransport implements Transport {
	/** Set to false to emulate a browser, which cannot send custom headers. */
	readonly capabilities: { headers: boolean };
	sent: (string | Uint8Array)[] = [];
	connectArgs: { url: string; headers: Record<string, string> } | undefined;
	closed = false;

	private readonly items: (TransportMessage | null)[] = [];
	private readonly waiters: ((message: TransportMessage | null) => void)[] = [];

	constructor(options: { headers?: boolean } = {}) {
		this.capabilities = { headers: options.headers ?? true };
	}

	connect(url: string, headers: Readonly<Record<string, string>>): Promise<void> {
		this.connectArgs = { url, headers: { ...headers } };
		return Promise.resolve();
	}

	send(data: string | Uint8Array): void {
		if (this.closed) throw new Error("MockTransport: send after close");
		this.sent.push(data);
	}

	receive(): Promise<TransportMessage | null> {
		const item = this.items.shift();
		if (item !== undefined) return Promise.resolve(item);
		if (this.closed) return Promise.resolve(null);
		return new Promise((resolve) => {
			this.waiters.push(resolve);
		});
	}

	close(): Promise<void> {
		if (!this.closed) {
			this.closed = true;
			for (const waiter of this.waiters.splice(0)) waiter(null);
		}
		return Promise.resolve();
	}

	/** Server → client. */
	push(data: string | Uint8Array): void {
		const message: TransportMessage = { data };
		const waiter = this.waiters.shift();
		if (waiter !== undefined) waiter(message);
		else this.items.push(message);
	}

	/** Server closes the connection. */
	end(): void {
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) waiter(null);
	}

	get textFrames(): string[] {
		return this.sent.filter((item): item is string => typeof item === "string");
	}

	get binaryFrames(): Uint8Array[] {
		return this.sent.filter((item): item is Uint8Array => typeof item !== "string");
	}
}

// ── JSON wire ──────────────────────────────────────────────────────────

export interface JsonMessageInput {
	event?: string;
	status?: number;
	statusText?: string;
	/** Sent as JSON text unless it is already a string. */
	payload?: unknown;
	raw?: boolean;
}

export function jsonMessage(input: JsonMessageInput = {}): string {
	const envelope: Record<string, unknown> = {
		task_id: "task",
		session_id: "session",
		namespace: "ASR",
		event: input.event ?? "",
		status_code: input.status ?? 20_000_000,
		status_text: input.statusText ?? "OK",
	};
	if (input.payload !== undefined) {
		envelope.payload = input.raw ? input.payload : JSON.stringify(input.payload);
	}
	return JSON.stringify(envelope);
}

/** A payload shaped like a real result message. */
export function resultPayload(
	results: Record<string, unknown>[] | null,
	extra?: Record<string, unknown>,
): Record<string, unknown> {
	return extra === undefined ? { results } : { results, extra };
}

// ── protobuf wire ──────────────────────────────────────────────────────

export interface ProtoResponseInput {
	type?: string;
	status?: number;
	statusMessage?: string;
	resultJson?: string;
}

/** Encode the fields the server actually uses: 4/5/6/7. */
export function protoResponse(input: ProtoResponseInput = {}): Uint8Array {
	const out: number[] = [];
	const text = new TextEncoder();
	const field = (number: number, value: string): void => {
		if (value.length === 0) return;
		const bytes = text.encode(value);
		out.push((number << 3) | 2, ...varint(bytes.length), ...bytes);
	};
	field(4, input.type ?? "");
	out.push((5 << 3) | 0, ...varint(input.status ?? 20_000_000));
	field(6, input.statusMessage ?? "OK");
	field(7, input.resultJson ?? "");
	return Uint8Array.from(out);
}

export interface DecodedRequest {
	token?: string;
	serviceName?: string;
	methodName?: string;
	payload?: string;
	audio?: Uint8Array;
	requestId?: string;
	frameState?: number;
}

/** Minimal decoder for assertions on what the session put on the wire. */
export function decodeRequest(bytes: Uint8Array): DecodedRequest {
	const decoder = new TextDecoder();
	const result: DecodedRequest = {};
	let offset = 0;
	const varint = (): number => {
		let value = 0;
		let shift = 0;
		for (;;) {
			const byte = bytes[offset];
			if (byte === undefined) throw new Error("decodeRequest: truncated varint");
			offset += 1;
			value += (byte & 0x7f) * 2 ** shift;
			if ((byte & 0x80) === 0) return value;
			shift += 7;
		}
	};
	while (offset < bytes.length) {
		const tag = varint();
		const field = tag >>> 3;
		const wireType = tag & 0x7;
		if (wireType === 0) {
			const value = varint();
			if (field === 9) result.frameState = value;
			continue;
		}
		const length = varint();
		const value = bytes.subarray(offset, offset + length);
		offset += length;
		switch (field) {
			case 2:
				result.token = decoder.decode(value);
				break;
			case 3:
				result.serviceName = decoder.decode(value);
				break;
			case 5:
				result.methodName = decoder.decode(value);
				break;
			case 6:
				result.payload = decoder.decode(value);
				break;
			case 7:
				// Copy: a view's `buffer` spans the whole message, not the frame.
				result.audio = Uint8Array.from(value);
				break;
			case 8:
				result.requestId = decoder.decode(value);
				break;
			default:
				break;
		}
	}
	return result;
}

// ── misc ───────────────────────────────────────────────────────────────

export function tick(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/** PCM ramp; distinct samples make ordering assertions unambiguous. */
export function ramp(samples: number, start = 0): Int16Array {
	const out = new Int16Array(samples);
	for (let index = 0; index < samples; index += 1) out[index] = (start + index) % 10_000;
	return out;
}

export function varint(value: number): number[] {
	const out: number[] = [];
	let rest = value;
	while (rest > 0x7f) {
		out.push((rest & 0x7f) | 0x80);
		rest = Math.floor(rest / 128);
	}
	out.push(rest);
	return out;
}
