import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The web client consumes the ASR package from source, like the workspace
// packages `vitest.base.ts` aliases for tests: it keeps HMR working on the
// package, and it is what lets `build:web` run without an ASR `dist/` (only the
// daemon's own `tsc` build needs that, for its `./node` declaration).
const asrSrc = fileURLToPath(new URL("../../asr/src", import.meta.url));

export default defineConfig({
	plugins: [tailwindcss(), react()],
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
