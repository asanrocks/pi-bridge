// ============================================================================
// userNotification — the notice's identity: one tag per Session, so two
// completions are two clickable notices instead of one replacing the other.
// The posting path itself needs a browser; only the identity is pure.
// ============================================================================

import { describe, expect, it } from "vitest";
import { notificationTag } from "./userNotification.ts";

describe("notificationTag", () => {
	it("gives each Session its own tag", () => {
		const a = notificationTag({ projectId: "acme", stem: "a" });
		const b = notificationTag({ projectId: "acme", stem: "b" });
		expect(a).not.toBe(b);
	});

	it("keeps the app prefix, so focus-close can take back every notice", () => {
		expect(notificationTag({ projectId: "acme", stem: "a" }).startsWith("pi-bridge-turn-complete")).toBe(true);
	});

	it("distinguishes Projects that share a stem", () => {
		expect(notificationTag({ projectId: "one", stem: "work" })).not.toBe(
			notificationTag({ projectId: "two", stem: "work" }),
		);
	});
});
