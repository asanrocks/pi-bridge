// The startup banner: the CLI's human output shape, pinned as lines instead of
// through a spawned process. The link is the `/@latest` alias in every role, so
// these cases own what a reader sees after `pi-bridge` in either deployment.

import { describe, expect, it } from "vitest";
import { bannerLines } from "../../src/cli-banner.ts";

const WEB = "http://localhost:33339";

describe("startup banner", () => {
	it("names the role, its Projects, and the @latest address", () => {
		const lines = bannerLines({
			role: "worker (connected to unix:/home/hugh/.pi/bridge.sock)",
			projects: ["spiral"],
			web: WEB,
		});
		expect(lines[0]).toMatch(/^pi-bridge \d/);
		expect(lines.slice(1)).toEqual([
			"Role: worker (connected to unix:/home/hugh/.pi/bridge.sock)",
			"Projects: spiral",
			"Visit: http://localhost:33339/@latest",
		]);
	});

	it("joins several Projects on one line", () => {
		const lines = bannerLines({ role: "worker (connected to unix:/s.sock)", projects: ["one", "two"], web: WEB });
		expect(lines).toContain("Projects: one, two");
	});

	it("omits the Projects line when this process serves none", () => {
		const lines = bannerLines({ role: "daemon (socket unix:/s.sock)", projects: [], web: WEB });
		expect(lines.some((line) => line.startsWith("Projects:"))).toBe(false);
	});

	it("says the address is unknown instead of guessing a port", () => {
		const lines = bannerLines({ role: "worker (connected to unix:/s.sock)", projects: ["spiral"], web: null });
		expect(lines.at(-1)).toBe("Visit: unavailable (the daemon reported no web address)");
	});

	it("keeps a hint below the facts", () => {
		const lines = bannerLines({
			role: "daemon+worker (socket unix:/s.sock)",
			projects: ["spiral"],
			web: WEB,
			note: "Note: this process hosts the shared daemon.",
		});
		expect(lines.at(-1)).toBe("Note: this process hosts the shared daemon.");
	});
});
