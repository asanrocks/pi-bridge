/**
 * Transport seam.
 *
 * The session never touches `WebSocket` directly: tests replay captured frames
 * through a fake, and an extension or same-origin relay can supply its own
 * implementation. Sending is synchronous because both `WebSocket.send` and the
 * fake queue; receiving is pull-based so the session can interleave reads with
 * audio pushes without a `select!`-style construct.
 */
import { AsrError } from "./errors.ts";

export interface TransportMessage {
	data: string | Uint8Array;
}

export interface TransportCapabilities {
	/** False in browsers, which cannot set `proto-version` (`docs/protocol.md` §2.3). */
	headers: boolean;
}

export interface Transport {
	readonly capabilities: TransportCapabilities;
	connect(url: string, headers: Readonly<Record<string, string>>): Promise<void>;
	send(data: string | Uint8Array): void;
	/** Resolves with `null` once the connection is closed. */
	receive(): Promise<TransportMessage | null>;
	close(code?: number, reason?: string): Promise<void>;
}

class MessageQueue {
	private readonly items: TransportMessage[] = [];
	private readonly waiters: ((item: TransportMessage | null) => void)[] = [];
	private closed = false;

	push(item: TransportMessage): void {
		if (this.closed) return;
		const waiter = this.waiters.shift();
		if (waiter !== undefined) waiter(item);
		else this.items.push(item);
	}

	end(): void {
		if (this.closed) return;
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) waiter(null);
	}

	next(): Promise<TransportMessage | null> {
		const item = this.items.shift();
		if (item !== undefined) return Promise.resolve(item);
		if (this.closed) return Promise.resolve(null);
		return new Promise((resolve) => {
			this.waiters.push(resolve);
		});
	}
}

/**
 * `WebSocket`-backed transport.
 *
 * Node >= 22 accepts `{ headers }` as the second constructor argument (an
 * undici extension); browsers do not, so they get the plain two-argument form
 * and `capabilities.headers === false`. The distinction is data, not detection,
 * so a bundler cannot silently pick the wrong branch.
 */
class WebSocketTransport implements Transport {
	readonly capabilities: TransportCapabilities;
	private socket: WebSocket | undefined;
	private readonly queue = new MessageQueue();
	private opened: Promise<void> | undefined;
	private failure: Error | undefined;

	constructor(options: { headers: boolean }) {
		this.capabilities = { headers: options.headers };
	}

	connect(url: string, headers: Readonly<Record<string, string>>): Promise<void> {
		if (this.socket !== undefined) {
			return Promise.reject(new AsrError("config", "transport: already connected"));
		}
		const socket = this.capabilities.headers
			? new WebSocket(url, { headers: { ...headers } } as never)
			: new WebSocket(url);
		socket.binaryType = "arraybuffer";
		this.socket = socket;

		this.opened = new Promise((resolve, reject) => {
			socket.onopen = () => {
				resolve();
			};
			socket.onerror = () => {
				// Browsers give no detail here; the close code arrives separately.
				const error = new AsrError("connection", `transport: cannot connect to ${url}`);
				this.failure ??= error;
				reject(error);
			};
			socket.onclose = (event) => {
				if (this.failure === undefined && event.code !== 1000) {
					this.failure = new AsrError(
						"connection",
						`transport: closed with code ${String(event.code)}${event.reason ? ` (${event.reason})` : ""}`,
					);
				}
				this.queue.end();
			};
			socket.onmessage = (event) => {
				const data: unknown = event.data;
				if (typeof data === "string") this.queue.push({ data });
				else if (data instanceof ArrayBuffer) this.queue.push({ data: new Uint8Array(data) });
				// Blob frames cannot happen: binaryType is 'arraybuffer'.
			};
		});
		return this.opened;
	}

	send(data: string | Uint8Array): void {
		const socket = this.socket;
		if (socket?.readyState !== 1) {
			throw new AsrError("connection", "transport: cannot send before the socket is open");
		}
		if (typeof data === "string") {
			socket.send(data);
			return;
		}
		// `WebSocket.send` wants an `ArrayBuffer`-backed view. Frames are allocated
		// by this package and never alias a `SharedArrayBuffer`, so a whole-buffer
		// view is safe; anything else is copied rather than silently truncated.
		const view = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice();
		socket.send(view.buffer as ArrayBuffer);
	}

	receive(): Promise<TransportMessage | null> {
		return this.queue.next();
	}

	async close(code = 1000, reason?: string): Promise<void> {
		const socket = this.socket;
		if (socket === undefined) return;
		if (socket.readyState === 0) {
			// Never opened: the pending `onerror`/`onclose` will end the queue.
			socket.close();
			return;
		}
		await new Promise<void>((resolve) => {
			const done = (): void => {
				resolve();
			};
			socket.addEventListener("close", done, { once: true });
			socket.close(code, reason);
		});
		this.queue.end();
	}
}

/**
 * Create a transport for the current runtime.
 *
 * `headers: true` is only correct on Node (or an extension); the browser entry
 * point passes `false` and the session refuses the protobuf wire there.
 */
export function webSocketTransport(options: { headers: boolean }): Transport {
	return new WebSocketTransport(options);
}
