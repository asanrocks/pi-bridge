// The app's half of the protocol version check: it accepts the daemon's own
// version and reports every other answer — including the absent field an older
// daemon sends — as skew, with both numbers intact for the UI to name.

import { describe, expect, it } from "vitest";
import { type GetDaemonInfoReply, PROTOCOL_VERSION } from "../../../../src/core/index.ts";
import { detectProtocolSkew } from "./protocolSkew.ts";

const info: GetDaemonInfoReply = {
	id: "1",
	ok: true,
	protocol: PROTOCOL_VERSION,
	projects: [],
	models: [],
	pinnedModels: [],
	visibleModels: [],
	thinkingLevels: [],
	devMode: false,
};

describe("detectProtocolSkew", () => {
	it("accepts the daemon's own protocol version", () => {
		expect(detectProtocolSkew(info)).toBeNull();
	});

	it("reports a newer daemon, which only a reload of this app can match", () => {
		expect(detectProtocolSkew({ ...info, protocol: PROTOCOL_VERSION + 1 })).toEqual({
			daemon: PROTOCOL_VERSION + 1,
			app: PROTOCOL_VERSION,
		});
	});

	it("reports an older daemon, which the page cannot replace", () => {
		expect(detectProtocolSkew({ ...info, protocol: PROTOCOL_VERSION - 1 })).toEqual({
			daemon: PROTOCOL_VERSION - 1,
			app: PROTOCOL_VERSION,
		});
	});

	it("treats a reply without a version as an older daemon", () => {
		// Wire input: the field is required by the type but absent from a daemon
		// built before the check, which is exactly the skew this names.
		const { protocol: omitted, ...withoutProtocol } = info;
		expect(omitted).toBe(PROTOCOL_VERSION);
		expect(detectProtocolSkew(withoutProtocol as GetDaemonInfoReply)).toEqual({
			daemon: null,
			app: PROTOCOL_VERSION,
		});
	});

	it("does not trust a version that is not an integer", () => {
		expect(detectProtocolSkew({ ...info, protocol: 1.5 })).toEqual({ daemon: null, app: PROTOCOL_VERSION });
	});
});
