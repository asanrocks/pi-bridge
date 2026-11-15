// The boot reload's one claim per daemon build: a reload creates a document
// with no memory, so without the claim a daemon whose served assets are not its
// own build would reload the page forever. Storage that cannot be written
// refuses the claim instead of looping.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuildStamp } from "../../../../src/core/index.ts";
import { claimBootReload, clearReloadClaim } from "./appUpgrade.ts";

const daemon: BuildStamp = { version: "1.5.0", commit: "b7697c1b8", date: "2026-11-11" };

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("claimBootReload", () => {
	it("grants the first reload for a build and refuses the next", () => {
		const store = new Map<string, string>();
		vi.stubGlobal("sessionStorage", {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => store.set(key, value),
			removeItem: (key: string) => store.delete(key),
		});

		expect(claimBootReload(daemon)).toBe(true);
		expect(claimBootReload(daemon)).toBe(false);
	});

	it("grants a reload for a different build", () => {
		const store = new Map<string, string>();
		vi.stubGlobal("sessionStorage", {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => store.set(key, value),
			removeItem: (key: string) => store.delete(key),
		});
		expect(claimBootReload(daemon)).toBe(true);
		expect(claimBootReload({ ...daemon, commit: "next" })).toBe(true);
	});

	it("refuses when the claim was released by a matching document", () => {
		const store = new Map<string, string>();
		vi.stubGlobal("sessionStorage", {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => store.set(key, value),
			removeItem: (key: string) => store.delete(key),
		});
		claimBootReload(daemon);
		clearReloadClaim();
		expect(claimBootReload(daemon)).toBe(true);
	});

	it("refuses when the browser cannot remember", () => {
		// Private mode: a visible state the reader can act on beats a reload loop.
		vi.stubGlobal("sessionStorage", {
			getItem: () => {
				throw new Error("denied");
			},
			setItem: () => {
				throw new Error("denied");
			},
			removeItem: () => {
				throw new Error("denied");
			},
		});
		expect(claimBootReload(daemon)).toBe(false);
	});
});
