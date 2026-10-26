// ============================================================================
// build-icons — the installable-app icon set, generated from the pi mark.
//
// The mark is pi's published logo (pi.dev/logo.svg) reduced to its defining
// shape: a 4×4 cell grid where each cell is a flat brand color or empty. The
// published SVG's paths are axis-aligned rectangles over that same grid, so the
// geometry can be expressed as cells and rasterized by hand — no image library,
// no committed binaries, and no drifted copy of the mark in git. `favicon.svg`
// on pi.dev uses the identical grid and `logo-auto.svg` adds the brand
// pigments. The TUI's 3D easter egg
// (`packages/coding-agent/src/modes/interactive/components/easter-egg-3d.ts`)
// is the same bitmap with one cell (`row 1, column 1`) left empty.
//
// Rasterizing means a nearest-neighbor cell fill on a node:zlib-deflated PNG:
// the mark is flat color on cell boundaries, so there is nothing to filter,
// anti-alias, or resample. Keeping the encoder here (instead of a dependency)
// also keeps `check:runtime-deps` honest — `sharp`/`canvas` exist in
// node_modules only as transitive leftovers and are not declared.
//
// Two placements, because launchers crop:
//   - any-purpose icons inset the mark to 80% of the tile, so a launcher's own
//     corner rounding never bites into a brand cell;
//   - the maskable icon insets it to 56.6%, the largest square that fits
//     inside Android's safe circle (radius 40% of the tile), because a
//     maskable icon is cropped to an arbitrary shape.
// Both sit on the page's light tone: an installed icon cannot follow
// `prefers-color-scheme`, and a colored tile reads on either home screen.
//
// Consumed by the vite plugin in `web/vite.config.ts`, which emits the files
// into the build (and serves them in dev) and by `test/suite/web-icons.test.ts`.
// That import is also what typechecks this file: `web/tsconfig.json` covers
// `web/src` only and stays DOM-only, so Node globals do not leak into the
// browser tree. Moving this file out of `web/` must keep that import alive.
// ============================================================================

import { deflateSync } from "node:zlib";

export type Rgb = readonly [number, number, number];

/** The mark's cells, top row first. `.` is background. */
const MARK_CELLS = ["ccc.", "bcc.", "bb.y", "b..y"];

/** Brand pigments from pi.dev/logo.svg. */
const MARK_COLORS: Record<string, Rgb> = {
	c: [0xf0, 0x90, 0x82], // coral
	b: [0x4d, 0x9a, 0xbf], // blue
	y: [0xf1, 0xbe, 0x58], // yellow
};

/** `--color-background` in the light ladder of `web/src/app/index.css`. */
const BACKGROUND: Rgb = [0xfa, 0xf9, 0xf6];

/**
 * Largest mark that survives Android's maskable crop: the safe circle has
 * radius 0.4·size, so an inscribed square has side 0.4·size·√2 ≈ 0.566·size.
 */
const MASKABLE_SHARE = 0.566;

export interface IconSpec {
	/** Path inside the web build root, leading slash omitted. */
	fileName: string;
	/** Square edge in pixels. */
	size: number;
	/** Share of the tile the mark spans, centered. */
	markShare: number;
}

export const ICON_SPECS: readonly IconSpec[] = [
	{ fileName: "icons/pi-192.png", size: 192, markShare: 0.8 },
	{ fileName: "icons/pi-512.png", size: 512, markShare: 0.8 },
	{ fileName: "icons/pi-maskable-512.png", size: 512, markShare: MASKABLE_SHARE },
	// iOS ignores the manifest for the home-screen icon and takes this link.
	{ fileName: "icons/apple-touch-180.png", size: 180, markShare: 0.8 },
];

/** A square RGBA raster, row-major, four bytes per pixel. */
export interface Raster {
	size: number;
	rgba: Uint8Array;
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "ascii");
	const tail = Buffer.alloc(4);
	tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), Buffer.from(data)])));
	return Buffer.concat([head, Buffer.from(data), tail]);
}

/** Rasterize one spec: the mark centered on a full-bleed background tile. */
export function renderIcon(spec: IconSpec): Raster {
	const { size } = spec;
	const rgba = new Uint8Array(size * size * 4);
	const side = Math.round(size * spec.markShare);
	const origin = Math.round((size - side) / 2);
	// Cell boundaries as integers: rounding each boundary instead of each sample
	// keeps cells exactly equal-width in pixels even when `side` is not a
	// multiple of four.
	const bounds = [0, 1, 2, 3, 4].map((k) => origin + Math.round((side * k) / 4));
	const cellOf = (coordinate: number): number | undefined => {
		for (let k = 0; k < 4; k++) {
			if (coordinate >= bounds[k]! && coordinate < bounds[k + 1]!) return k;
		}
		return undefined;
	};

	for (let y = 0; y < size; y++) {
		const row = cellOf(y);
		for (let x = 0; x < size; x++) {
			const column = cellOf(x);
			const cell = row === undefined || column === undefined ? "." : MARK_CELLS[row]![column]!;
			const rgb = MARK_COLORS[cell] ?? BACKGROUND;
			const offset = (y * size + x) * 4;
			rgba[offset] = rgb[0];
			rgba[offset + 1] = rgb[1];
			rgba[offset + 2] = rgb[2];
			rgba[offset + 3] = 255;
		}
	}

	return { size, rgba };
}

/** Encode a raster as an 8-bit RGBA PNG (filter 0 on every row). */
export function encodePng(raster: Raster): Buffer {
	const { size, rgba } = raster;
	const raw = Buffer.alloc(size * (size * 4 + 1));
	for (let y = 0; y < size; y++) {
		const rowStart = y * (size * 4 + 1);
		raw[rowStart] = 0;
		Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, rowStart + 1);
	}

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // color type: truecolor with alpha
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", new Uint8Array(0)),
	]);
}

/**
 * The browser-tab icon: the mark itself, full-bleed on transparency, in brand
 * colors. A colored mark stays legible on both light and dark tab strips, so
 * this file needs no `prefers-color-scheme` rule — one inside an SVG loaded as
 * an icon does not follow the OS reliably.
 */
export function renderFaviconSvg(): string {
	const rects: string[] = [];
	for (let row = 0; row < MARK_CELLS.length; row++) {
		for (let column = 0; column < 4; column++) {
			const cell = MARK_CELLS[row]![column]!;
			const rgb = MARK_COLORS[cell];
			if (!rgb) continue;
			const fill = `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
			rects.push(`  <rect x="${column}" y="${row}" width="1" height="1" fill="${fill}"/>`);
		}
	}
	return [
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4" width="256" height="256">',
		...rects,
		"</svg>",
		"",
	].join("\n");
}

/** Every file the build must emit, keyed by its path inside the web build root. */
export function iconFiles(): Array<{ fileName: string; content: Buffer | string }> {
	return [
		...ICON_SPECS.map((spec) => ({ fileName: spec.fileName, content: encodePng(renderIcon(spec)) })),
		{ fileName: "favicon.svg", content: renderFaviconSvg() },
	];
}
