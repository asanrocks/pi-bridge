// Regression: the single-file bundle (scripts/bundle-single.mjs) inlines the
// CJS @silvia-odwyer/photon-node into an ESM output. That package loads its
// wasm with fs.readFileSync(path.join(__dirname, "photon_rs_bg.wasm")), which
// throws in ESM (no `__dirname`) and made every image read report
// "could not be resized below the inline image size limit". The shared bundle
// banner must define `__dirname`, embed the wasm, and satisfy the read from
// memory. This builds a probe with the same esbuild shape and asserts the
// image pipeline actually runs.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { buildBundleBanner, readPhotonWasmBase64 } from "../../scripts/bundle-banner.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const photonSource = resolve(testDir, "../../../coding-agent/src/utils/photon.ts");
const imageProcessSource = resolve(testDir, "../../../coding-agent/src/utils/image-process.ts");

// 1x1 PNG. Small enough that resizing is a pass-through, but the pipeline
// still needs Photon to load before it checks the dimensions.
const ONE_BY_ONE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const workDir = mkdtempSync(join(tmpdir(), "pi-bridge-photon-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe("single-file bundle Photon embedding", () => {
	it("processes an image through the bundled Photon", async () => {
		const probePath = join(workDir, "probe.mjs");
		const bundlePath = join(workDir, "probe-bundle.mjs");
		writeFileSync(
			probePath,
			[
				`import { loadPhoton } from ${JSON.stringify(photonSource)};`,
				`import { processImage } from ${JSON.stringify(imageProcessSource)};`,
				`const png = Buffer.from(${JSON.stringify(ONE_BY_ONE_PNG)}, "base64");`,
				"const photon = await loadPhoton();",
				'const result = await processImage(new Uint8Array(png), "image/png", { autoResizeImages: true });',
				'console.log(JSON.stringify({ photon: photon !== null, ok: result.ok, message: result.ok ? "" : result.message }));',
			].join("\n"),
		);

		await build({
			entryPoints: [probePath],
			bundle: true,
			platform: "node",
			format: "esm",
			outfile: bundlePath,
			external: ["node:*"],
			minify: true,
			banner: { js: buildBundleBanner(readPhotonWasmBase64()) },
			logOverride: { "ignored-bare-import": "silent" },
		});

		const stdout = execFileSync(process.execPath, [bundlePath], { encoding: "utf8" });
		const lastLine = stdout.trim().split("\n").pop() ?? "";
		expect(JSON.parse(lastLine)).toEqual({ photon: true, ok: true, message: "" });
	}, 30_000);
});
