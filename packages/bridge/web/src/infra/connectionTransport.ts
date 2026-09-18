// ============================================================================
// connectionTransport — the WebSocket transport adapter and the reconnect
// backoff schedule for the client connection layer.
// ============================================================================

import type { BridgeTransport } from "../../../src/core/index.ts";

export class WsTransport implements BridgeTransport {
	private ws: WebSocket;
	onMessage: ((data: string) => void) | null = null;

	constructor(ws: WebSocket) {
		this.ws = ws;
		ws.onmessage = (ev) => {
			if (this.onMessage) this.onMessage(ev.data as string);
		};
	}

	send(data: string): void {
		if (this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(data);
		}
	}
}

export function backoff(attempt: number): number {
	const base = 500;
	const cap = 5000;
	const jitter = Math.random();
	return Math.min(base * 2 ** attempt, cap) * (1 + jitter * 0.3);
}
