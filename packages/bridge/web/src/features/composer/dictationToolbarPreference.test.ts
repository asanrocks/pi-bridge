import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDictationToolbarOpen, saveDictationToolbarOpen } from "./dictationToolbarPreference.ts";

/** A minimal `localStorage` stand-in: node has none, and the preference is the
 * one thing that has to behave with and without it. */
function stubStorage(initial: Record<string, string> = {}): Map<string, string> {
	const map = new Map(Object.entries(initial));
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => void map.set(key, value),
	});
	return map;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("dictationToolbarPreference", () => {
	it("starts closed when nothing is stored", () => {
		stubStorage();
		expect(loadDictationToolbarOpen()).toBe(false);
	});

	it("round-trips both states", () => {
		const storage = stubStorage();
		saveDictationToolbarOpen(true);
		expect(loadDictationToolbarOpen()).toBe(true);
		saveDictationToolbarOpen(false);
		expect(loadDictationToolbarOpen()).toBe(false);
		// One key, readable words: a stale value can only mean closed.
		expect([...storage.values()]).toEqual(["closed"]);
	});

	it("treats an unrecognized value as closed", () => {
		stubStorage({ "pi-bridge:dictation-toolbar": "yes" });
		expect(loadDictationToolbarOpen()).toBe(false);
	});

	it("degrades to closed when storage throws", () => {
		vi.stubGlobal("localStorage", {
			getItem: () => {
				throw new Error("denied");
			},
			setItem: () => {
				throw new Error("denied");
			},
		});
		expect(loadDictationToolbarOpen()).toBe(false);
		expect(() => saveDictationToolbarOpen(true)).not.toThrow();
	});

	it("degrades to closed with no storage at all", () => {
		vi.stubGlobal("localStorage", undefined);
		expect(loadDictationToolbarOpen()).toBe(false);
		expect(() => saveDictationToolbarOpen(true)).not.toThrow();
	});
});
