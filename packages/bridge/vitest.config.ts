import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

const codingAgentSrc = fileURLToPath(new URL("../coding-agent/src/index.ts", import.meta.url));

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			environment: "node",
			testTimeout: 30000,
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			silent: "passed-only",
			setupFiles: ["./test/setup.ts"],
			// The SSR dep optimizer used to pre-bundle coding-agent here. Upstream's
			// codemode extension now reads `getDocsPath()` at module load, and the
			// optimizer's chunk splitting into a barrel/circular import graph leaves
			// config.ts's module-level `__dirname` uninitialized at that point
			// (esbuild hoists it to `var`). Running modules unbundled keeps each
			// file's own `import.meta.url` and eval order correct; the full suite
			// still finishes in well under a minute.
		},
		resolve: {
			// `vitest.base.ts` aliases the workspace packages to their sources; only
			// coding-agent itself is bridge-specific (the base config omits it because
			// the coding-agent suite aliases its own source).
			alias: [
				{ find: /^@earendil-works\/pi-coding-agent$/, replacement: codingAgentSrc },
				{ find: /^@earendil-works\/pi-coding-agent\//, replacement: codingAgentSrc },
			],
		},
	}),
);
