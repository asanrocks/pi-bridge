// Wording and remedy for each connection state. Both surfaces render from this
// mapping, so the tests pin the two decisions a user can act on: that a build
// mismatch offers exactly one gesture, and which states retry by themselves.

import { describe, expect, it } from "vitest";
import type { BuildStamp } from "../../../../src/core/index.ts";
import { connectionStatus } from "./connectionStatus.ts";

const app: BuildStamp = { version: "1.5.0", commit: "69a37925f", date: "2026-11-11" };

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

describe("build mismatch", () => {
	it("offers the reload and both builds", () => {
		// One remedy: the daemon serves the app, so a reload takes its copy.
		const daemon = { ...app, commit: "b7697c1b8" };
		const status = connectionStatus({ kind: "build_mismatch", daemon, app, retried: false });
		expect(status).toMatchObject({
			label: "App out of date",
			action: "reload-app",
			actionLabel: "Reload page",
			tone: "warn",
			blink: true,
			autoRetry: false,
		});
		expect(status?.detail).toContain("1.5.0+b7697c1b8");
		expect(status?.detail).toContain("1.5.0+69a37925f");
	});

	it("states the stuck case once a reload has already run", () => {
		const daemon = { ...app, commit: "b7697c1b8" };
		const status = connectionStatus({ kind: "build_mismatch", daemon, app, retried: true });
		expect(status).toMatchObject({ label: "Builds disagree", action: "reload-app" });
		expect(status?.detail).toContain("restart pi-bridge");
	});

	it("names a daemon that reports no build as an older build", () => {
		const status = connectionStatus({ kind: "build_mismatch", daemon: null, app, retried: false });
		expect(status?.detail).toContain("an older build with no stamp");
	});

	it("never offers a re-handshake", () => {
		// A retry cannot change either build; the action is the reload alone.
		const daemon = { ...app, commit: "b7697c1b8" };
		expect(connectionStatus({ kind: "build_mismatch", daemon, app, retried: true })?.action).toBe("reload-app");
	});
});
