// devConsole — the console relay's lifetime. The hooks are installed once per
// page and repointed at the current client; re-hooking on reconnect must not
// nest wrappers (each line would be relayed once per connection the page ever
// had, through dead sockets), and unhooking must restore the originals.

import { afterEach, describe, expect, it } from "vitest";
import { BridgeClient, type BridgeTransport } from "../../../../src/core/index.ts";
import { hookConsole, unhookConsole } from "./devConsole.ts";

class RecordingTransport implements BridgeTransport {
	sent: Array<Record<string, unknown>> = [];
	onMessage: ((data: string) => void) | null = null;

	send(data: string): void {
		this.sent.push(JSON.parse(data) as Record<string, unknown>);
	}

	consoleFrames(): Array<{ level: string; args: unknown[] }> {
		return this.sent
			.filter((f) => f.verb === "console")
			.map((f) => ({ level: f.level as string, args: f.args as unknown[] }));
	}
}

function makeClient(): { client: BridgeClient; transport: RecordingTransport } {
	const transport = new RecordingTransport();
	return { client: new BridgeClient(transport), transport };
}

afterEach(() => {
	unhookConsole();
});

describe("devConsole relay", () => {
	it("relays each line exactly once through the hooked client", () => {
		const { client, transport } = makeClient();
		hookConsole(client);

		console.warn("one");

		expect(transport.consoleFrames()).toEqual([{ level: "warn", args: ["one"] }]);
	});

	it("re-hooking repoints the relay instead of nesting wrappers", () => {
		const first = makeClient();
		const second = makeClient();
		hookConsole(first.client);
		// A reconnect: the new connection's init reports dev mode and hooks again.
		hookConsole(second.client);

		console.error("after reconnect");

		// One frame, through the current client only — not one per hook call,
		// and nothing through the replaced client.
		expect(second.transport.consoleFrames()).toEqual([{ level: "error", args: ["after reconnect"] }]);
		expect(first.transport.consoleFrames()).toEqual([]);
	});

	it("unhooking restores the originals and relays nothing", () => {
		const { client, transport } = makeClient();
		hookConsole(client);
		const hooked = console.log;

		unhookConsole();

		// The original method is back in place (not the relay wrapper)...
		expect(console.log).not.toBe(hooked);
		// ...and nothing is relayed anymore.
		console.log("after unhook");
		expect(transport.consoleFrames()).toEqual([]);
	});

	it("non-JSON-safe arguments are relayed as safe values", () => {
		const { client, transport } = makeClient();
		hookConsole(client);

		console.log("msg", new Error("boom"), { a: 1 });

		const frames = transport.consoleFrames();
		expect(frames).toHaveLength(1);
		expect(frames[0].args).toEqual(["msg", "boom", { a: 1 }]);
	});
});
