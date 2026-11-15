// The launcher's version line: one wording for the app's build and the daemon's,
// and the pair a reader copies when reporting a problem. The renderer is not
// exercised here — the decision a reader acts on is the text.

import { describe, expect, it } from "vitest";
import type { BuildStamp } from "../../../../src/core/index.ts";
import { buildFooterText } from "./BuildFooter.tsx";

const app: BuildStamp = { version: "1.5.0", commit: "69a37925f", date: "2026-11-11" };
const daemon: BuildStamp = { version: "1.5.0", commit: "b7697c1b8", date: "2026-11-15" };

describe("buildFooterText", () => {
	it("names one build when the daemon agrees", () => {
		expect(buildFooterText(app, app)).toEqual({
			text: "pi-bridge 1.5.0+69a37925f",
			detail: "app: 1.5.0, 69a37925f, 2026-11-11\ndaemon: 1.5.0, 69a37925f, 2026-11-11",
			differs: false,
		});
	});

	it("names both builds when the commits differ", () => {
		expect(buildFooterText(app, daemon)).toMatchObject({
			text: "app 1.5.0+69a37925f · daemon 1.5.0+b7697c1b8",
			differs: true,
		});
	});

	it("states that the daemon has not reported yet", () => {
		// Before the aggregate arrives nothing is known; a guessed stamp would be
		// worse than the gap.
		expect(buildFooterText(app, null)).toMatchObject({
			text: "pi-bridge 1.5.0+69a37925f · daemon not reported",
			differs: false,
		});
	});

	it("never calls a checkout daemon different", () => {
		// The daemon is canonical: its marker stamp turns the verdict off, while a
		// reader still sees which build the page itself is running.
		const dev: BuildStamp = { version: "0.0.0", commit: "dev", date: "1970-01-01" };
		expect(buildFooterText(dev, dev)).toMatchObject({ text: "pi-bridge a development build", differs: false });
		expect(buildFooterText(app, dev)).toMatchObject({
			text: "app 1.5.0+69a37925f · daemon a development build",
			differs: false,
		});
	});

	it("names a dev app against a stamped daemon, and calls it different", () => {
		// The page is the side that has to move, so the hue is earned here.
		const dev: BuildStamp = { version: "0.0.0", commit: "dev", date: "1970-01-01" };
		expect(buildFooterText(dev, daemon)).toMatchObject({
			text: "app a development build · daemon 1.5.0+b7697c1b8",
			differs: true,
		});
	});

	it("copies both triples whatever the verdict", () => {
		expect(buildFooterText(app, daemon).detail).toBe(
			"app: 1.5.0, 69a37925f, 2026-11-11\ndaemon: 1.5.0, b7697c1b8, 2026-11-15",
		);
	});
});
