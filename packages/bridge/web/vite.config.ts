import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { readBuildStamp } from "../scripts/build-stamp.mjs";
import { iconFiles } from "./build-icons.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

// The stamp baked into the app: the same identity the Daemon reports, so the two
// halves of one deployment compare equal (core/build-identity.ts). Development
// mode deliberately gets the marker stamp, which switches the check off — and
// writes `.dev-build`, which makes `bundle-single.mjs` refuse to ship it.
const DEV_BUILD_MARKER = ".dev-build";

// The web client consumes the ASR package from source, like the workspace
// packages `vitest.base.ts` aliases for tests: it keeps HMR working on the
// package, and it is what lets `build:web` run without an ASR `dist/` (only the
// daemon's own `tsc` build needs that, for its `./node` declaration).
const asrSrc = fileURLToPath(new URL("../../asr/src", import.meta.url));

/**
 * Emits the generated icon set (see `build-icons.ts`) into the build root and
 * serves it from the dev server, so `dist/web` is the whole asset surface the
 * daemon reads — the disk web root and the single-file binary's embedded map
 * both. `public/manifest.webmanifest` is a committed file; only the rasters are
 * generated, because they are derivable from the mark and nothing binary
 * belongs in review.
 */
function iconsPlugin(): Plugin {
	const files = iconFiles();
	const served = new Map(
		files.map((file) => [
			`/${file.fileName}`,
			{ content: file.content, type: file.fileName.endsWith(".svg") ? "image/svg+xml" : "image/png" },
		]),
	);

	return {
		name: "pi-bridge-icons",
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const path = req.url?.split("?")[0];
				const hit = path === undefined ? undefined : served.get(path);
				if (!hit) {
					next();
					return;
				}
				res.writeHead(200, { "Content-Type": hit.type });
				res.end(hit.content);
			});
		},
		generateBundle() {
			for (const file of files) this.emitFile({ type: "asset", fileName: file.fileName, source: file.content });
		},
	};
}

export default defineConfig(({ mode }) => {
	const dev = mode === "development";
	const stamp = readBuildStamp(root, { dev });

	return {
		plugins: [tailwindcss(), react(), iconsPlugin(), devBuildMarkerPlugin(dev)],
		resolve: {
			alias: [
				{ find: /^@earendil-works\/pi-asr\/dictation$/, replacement: `${asrSrc}/dictation/index.ts` },
				{ find: /^@earendil-works\/pi-asr\/dom$/, replacement: `${asrSrc}/dom/index.ts` },
			],
		},
		// The app's own build identity, read through `infra/lib/buildStamp.ts`.
		// Substituted at build time so the bundle carries it without an import.
		define: { __PI_BRIDGE_BUILD__: JSON.stringify(stamp) },
		server: {
			host: "127.0.0.1",
			port: 5173,
		},
		build: {
			outDir: "../dist/web",
			emptyOutDir: true,
			sourcemap: false,
			minify: false,
		},
	};
});

/** Mark a development bundle, so the packaging step can refuse it instead of
 * shipping an app whose build check is switched off. */
function devBuildMarkerPlugin(dev: boolean): Plugin {
	let outDir = "";
	return {
		name: "pi-bridge-dev-build-marker",
		configResolved(config) {
			// `outDir` arrives as written (the default config's `../dist/web` is
			// relative to the web root), so it is resolved here once rather than
			// against whatever the process cwd happens to be.
			outDir = resolve(config.root, config.build.outDir);
		},
		closeBundle() {
			if (dev) writeFileSync(join(outDir, DEV_BUILD_MARKER), "built by npm run build:web:dev\n");
		},
	};
}
