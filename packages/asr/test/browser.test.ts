import { describe, expect, it } from "vitest";
import { AsrSession } from "../src/browser.ts";

describe("browser entry point", () => {
	it("rejects the protobuf wire instead of constructing a header-carrying socket", async () => {
		// `new WebSocket(url, { headers })` is a Node extension: in a browser the
		// second argument is the subprotocol list and throws a TypeError. The browser
		// entry must fail as a typed error before any socket exists.
		const session = new AsrSession({ wire: "protobuf", auth: { token: "sami" } });
		await expect(session.connect()).rejects.toMatchObject({ code: "unsupported" });
		expect(session.state).toBe("closed");
	});
});
