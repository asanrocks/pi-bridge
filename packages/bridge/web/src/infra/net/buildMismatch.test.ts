// The app's half of the build check: it accepts the daemon's own build and
// reports every other answer — including the absent field an older daemon sends
// — as a mismatch, with both stamps intact for the UI to name. Development
// builds on either side switch the check off.

import { describe, expect, it } from "vitest";
import type { BuildStamp, GetDaemonInfoReply } from "../../../../src/core/index.ts";
import { detectBuildMismatch } from "./buildMismatch.ts";

const app: BuildStamp = { version: "1.5.0", commit: "69a37925f", date: "2026-11-11" };

const info: GetDaemonInfoReply = {
	id: "1",
	ok: true,
	revision: 1,
	build: app,
	projects: [],
	models: [],
	pinnedModels: [],
	visibleModels: [],
	thinkingLevels: [],
	devMode: false,
};

describe("detectBuildMismatch", () => {
	it("accepts a daemon built from the same commit", () => {
		expect(detectBuildMismatch(info, app)).toBeNull();
	});

	it("accepts another version and date of the same commit", () => {
		// Identity is the commit: a rebuild of one tree is the same program.
		const rebuilt = { version: "1.5.1", commit: app.commit, date: "2026-12-01" };
		expect(detectBuildMismatch({ ...info, build: rebuilt }, app)).toBeNull();
	});

	it("reports a daemon from another commit", () => {
		const daemon = { ...app, commit: "b7697c1b8" };
		expect(detectBuildMismatch({ ...info, build: daemon }, app)).toEqual({ daemon, app });
	});

	it("treats a reply without a build as an older daemon", () => {
		// Wire input: the field is required by the type but absent from a daemon
		// built before the check, which is exactly the mismatch this names.
		const { build: omitted, ...withoutBuild } = info;
		expect(omitted).toEqual(app);
		expect(detectBuildMismatch(withoutBuild as GetDaemonInfoReply, app)).toEqual({ daemon: null, app });
	});

	it("does not trust a build that is not a stamp", () => {
		const malformed = { ...info, build: { commit: 7 } } as unknown as GetDaemonInfoReply;
		expect(detectBuildMismatch(malformed, app)).toEqual({ daemon: null, app });
	});

	it("still compares when this app is a development build", () => {
		// Development is the daemon's call: a dev app against a stamped daemon is a
		// real disagreement, and the page is the side that can move.
		const dev = { version: "0.0.0", commit: "dev", date: "1970-01-01" };
		const daemon = { ...app, commit: "b7697c1b8" };
		expect(detectBuildMismatch({ ...info, build: daemon }, dev)).toEqual({ daemon, app: dev });
	});

	it("is off when the daemon is a development build", () => {
		// The canonical side says development, so every peer's check is off.
		const dev = { version: "0.0.0", commit: "dev", date: "1970-01-01" };
		expect(detectBuildMismatch({ ...info, build: dev }, app)).toBeNull();
		expect(detectBuildMismatch({ ...info, build: dev }, dev)).toBeNull();
	});
});
