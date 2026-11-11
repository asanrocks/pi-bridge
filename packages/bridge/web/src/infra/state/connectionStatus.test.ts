// Wording and remedy for each connection state. Both surfaces render from this
// mapping, so the tests pin the two decisions a user can act on: which side of a
// version mismatch is fixed by a reload, and which states retry by themselves.

import { describe, expect, it } from "vitest";
import { connectionStatus } from "./connectionStatus.ts";

describe("connectionStatus", () => {
	it("has no affordance while connected", () => {
		expect(connectionStatus({ kind: "connected" })).toBeNull();
	});

	it("offers nothing to click on the first attempt", () => {
		expect(connectionStatus({ kind: "connecting" })).toMatchObject({ action: null, autoRetry: false });
	});

	it("lets a dropped connection retry itself", () => {
		expect(connectionStatus({ kind: "reconnecting", attempt: 2 })).toMatchObject({
			action: "retry",
			autoRetry: true,
		});
	});
});

describe("version mismatch", () => {
	it("offers a reload when the app is the older side", () => {
		// The daemon serves the app from disk, so a reload takes the daemon's copy.
		expect(connectionStatus({ kind: "version_mismatch", daemon: 5, app: 4 })).toMatchObject({
			label: "App out of date",
			action: "reload-app",
			actionLabel: "Reload app",
			tone: "warn",
			blink: true,
			autoRetry: false,
		});
	});

	it("names the daemon as the fix when the daemon is the older side", () => {
		// Reloading re-serves this same app: only restarting the process helps.
		const status = connectionStatus({ kind: "version_mismatch", daemon: 3, app: 4 });
		expect(status).toMatchObject({
			label: "Daemon out of date",
			action: "check-again",
			tone: "warn",
			blink: true,
			autoRetry: false,
		});
		expect(status?.detail).toContain("Restart pi-bridge");
		expect(status?.detail).toContain("3");
	});

	it("treats a daemon that reports no version as the older side", () => {
		expect(connectionStatus({ kind: "version_mismatch", daemon: null, app: 4 })).toMatchObject({
			action: "check-again",
		});
	});
});
