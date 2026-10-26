import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { iconFiles } from "./build-icons.ts";

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

export default defineConfig({
	plugins: [tailwindcss(), react(), iconsPlugin()],
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-asr\/dictation$/, replacement: `${asrSrc}/dictation/index.ts` },
			{ find: /^@earendil-works\/pi-asr\/dom$/, replacement: `${asrSrc}/dom/index.ts` },
		],
	},
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
});
