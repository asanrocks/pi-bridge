// headerDensity — the ADR 21 header tiers and the exclusive-ownership matrix.
// The interesting cases are the boundaries and the unmeasured column: an
// off-by-one at 560 moves Copy into the menu, and a missing tier for an
// unmeasured column would render every control on first paint.

import { describe, expect, test } from "vitest";
import { COMPACT_HEADER_WIDTH, headerDensity, inlineControls, WIDE_HEADER_WIDTH } from "./headerDensity.ts";

describe("headerDensity", () => {
	test("reads the tier from the column width, not the viewport", () => {
		expect(headerDensity(768)).toBe("wide");
		expect(headerDensity(WIDE_HEADER_WIDTH)).toBe("wide");
		expect(headerDensity(WIDE_HEADER_WIDTH - 1)).toBe("compact");
		expect(headerDensity(COMPACT_HEADER_WIDTH)).toBe("compact");
		expect(headerDensity(COMPACT_HEADER_WIDTH - 1)).toBe("narrow");
	});

	test("an unmeasured or unusable column takes the narrow tier", () => {
		expect(headerDensity(0)).toBe("narrow");
		expect(headerDensity(-1)).toBe("narrow");
		expect(headerDensity(Number.NaN)).toBe("narrow");
		expect(headerDensity(Number.POSITIVE_INFINITY)).toBe("narrow");
	});
});

describe("inlineControls", () => {
	test("wide keeps the whole toolbar", () => {
		expect(inlineControls("wide")).toEqual({ copy: true, pager: true, edit: true });
	});

	test("compact keeps Edit only", () => {
		expect(inlineControls("compact")).toEqual({ copy: false, pager: false, edit: true });
	});

	test("narrow keeps nothing: the menu owns every command", () => {
		expect(inlineControls("narrow")).toEqual({ copy: false, pager: false, edit: false });
	});
});
