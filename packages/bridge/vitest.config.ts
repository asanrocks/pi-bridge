import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const codingAgentSrc = fileURLToPath(new URL("../coding-agent/src/index.ts", import.meta.url));
const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../ai/src/compat.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
		setupFiles: ["./test/setup.ts"],
		// The workspace packages below are aliased to TypeScript source, so the
		// module runner otherwise re-transforms and re-executes the full
		// coding-agent/ai graph in every test file (~460 modules, ~185s summed).
		// Pre-bundling them collapses that to a single cached module. `force`
		// re-runs esbuild from source on every invocation: Vite's dep-optimizer
		// cache is keyed on lockfile + config only, never source contents, so
		// without it an edit to coding-agent/src would silently test stale code.
		deps: {
			optimizer: {
				ssr: {
					enabled: true,
					force: true,
					include: [
						"@earendil-works/pi-coding-agent",
						"@earendil-works/pi-ai",
						"@earendil-works/pi-ai/compat",
						"@earendil-works/pi-agent-core",
					],
				},
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-coding-agent$/, replacement: codingAgentSrc },
			{ find: /^@earendil-works\/pi-coding-agent\//, replacement: codingAgentSrc },
			{ find: /^@earendil-works\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@earendil-works\/pi-ai\/compat$/, replacement: aiSrcCompat },
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@earendil-works\/pi-agent-core\//, replacement: agentSrcIndex },
		],
	},
});
