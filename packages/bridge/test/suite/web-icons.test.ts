// Installability surface: the generated icon set and the manifest that points
// at it. The icons are derived from the pi mark at build time, so nothing here
// reads a committed binary; the manifest is committed, so the last block is the
// drift guard between the two — a manifest entry naming an icon the generator
// does not produce is exactly the failure that makes Chromium report the app as
// non-installable with no other symptom.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { encodePng, ICON_SPECS, renderFaviconSvg, renderIcon } from "../../web/build-icons.ts";

const MANIFEST_PATH = fileURLToPath(new URL("../../web/public/manifest.webmanifest", import.meta.url));

interface Manifest {
	id?: string;
	name?: string;
	short_name?: string;
	start_url?: string;
	scope?: string;
	display?: string;
	icons?: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
	prefer_related_applications?: boolean;
}

function rgbaAt(raster: { size: number; rgba: Uint8Array }, x: number, y: number): number[] {
	const offset = (y * raster.size + x) * 4;
	return [raster.rgba[offset]!, raster.rgba[offset + 1]!, raster.rgba[offset + 2]!, raster.rgba[offset + 3]!];
}

describe("generated icons", () => {
	it("encodes a valid square RGBA PNG per spec", () => {
		for (const spec of ICON_SPECS) {
			const png = encodePng(renderIcon(spec));
			expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
			// IHDR is the first chunk: 8-byte header, then length, type, width, height.
			expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
			expect(png.readUInt32BE(16)).toBe(spec.size);
			expect(png.readUInt32BE(20)).toBe(spec.size);
			// 8-bit truecolor with alpha, and no interlacing.
			expect(png[24]).toBe(8);
			expect(png[25]).toBe(6);
			expect(png[28]).toBe(0);
			expect(png.subarray(png.length - 8, png.length - 4).toString("ascii")).toBe("IEND");
		}
	});

	it("keeps every mark pixel inside Android's maskable safe circle", () => {
		const maskable = ICON_SPECS.find((spec) => spec.fileName.includes("maskable"));
		expect(maskable, "a maskable spec must exist").toBeDefined();
		const raster = renderIcon(maskable!);
		const background = rgbaAt(raster, 0, 0);
		const centre = raster.size / 2;
		const safe = raster.size * 0.4;

		for (let y = 0; y < raster.size; y++) {
			for (let x = 0; x < raster.size; x++) {
				const distance = Math.hypot(x + 0.5 - centre, y + 0.5 - centre);
				if (distance <= safe) continue;
				expect(rgbaAt(raster, x, y), `pixel ${x},${y} outside the safe circle`).toEqual(background);
			}
		}
	});

	it("insets any-purpose icons less than the maskable one, and leaves margins", () => {
		const anyPurpose = renderIcon(ICON_SPECS.find((spec) => spec.fileName === "icons/pi-512.png")!);
		const maskable = renderIcon(ICON_SPECS.find((spec) => spec.fileName === "icons/pi-maskable-512.png")!);
		const background = rgbaAt(anyPurpose, 0, 0);
		const painted = (raster: { size: number; rgba: Uint8Array }): number => {
			let count = 0;
			for (let y = 0; y < raster.size; y++) {
				for (let x = 0; x < raster.size; x++)
					if (!rgbaAt(raster, x, y).every((v, i) => v === background[i])) count++;
			}
			return count;
		};
		expect(painted(anyPurpose)).toBeGreaterThan(painted(maskable));
		// A launcher's corner rounding must not bite into a brand cell: the mark's
		// own bounding box stays off the tile edge.
		expect(rgbaAt(anyPurpose, 0, 0)).toEqual(background);
		expect(rgbaAt(anyPurpose, anyPurpose.size - 1, anyPurpose.size - 1)).toEqual(background);
	});

	it("serializes the mark as a full-bleed favicon in brand colors", () => {
		const svg = renderFaviconSvg();
		expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"')).toBe(true);
		expect(svg.match(/<rect /g)).toHaveLength(11);
		for (const fill of ["#f09082", "#4d9abf", "#f1be58"]) expect(svg).toContain(`fill="${fill}"`);
		// One media query inside an SVG loaded as an icon does not follow the OS
		// reliably, so the favicon must carry no scheme branching.
		expect(svg).not.toContain("prefers-color-scheme");
	});
});

describe("install manifest", () => {
	const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;

	it("satisfies Chromium's installability members", () => {
		expect(manifest.name).toBe("pi-bridge");
		expect(manifest.short_name).toBe("pi-bridge");
		expect(manifest.start_url).toBe("/");
		// A fixed id keeps app identity across a start_url change.
		expect(manifest.id).toBe("/");
		expect(["standalone", "minimal-ui", "fullscreen"]).toContain(manifest.display);
		expect(manifest.prefer_related_applications).not.toBe(true);
	});

	it("declares the required sizes, including a maskable icon", () => {
		const icons = manifest.icons ?? [];
		expect(icons.map((icon) => icon.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
		expect(icons.some((icon) => icon.purpose === "maskable")).toBe(true);
		for (const icon of icons) expect(icon.type).toBe("image/png");
	});

	it("references exactly the icons the build emits", () => {
		const emitted = new Set(ICON_SPECS.map((spec) => `/${spec.fileName}`));
		for (const icon of manifest.icons ?? []) expect(emitted.has(icon.src), `${icon.src} is not generated`).toBe(true);
	});
});
