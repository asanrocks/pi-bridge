import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

const codingAgentSrc = fileURLToPath(new URL("../coding-agent/src/index.ts", import.meta.url));

// Test files that mutate state a reused module graph would carry into the next
// file: `vi.mock` factories (hoisted per file, never unregistered), global
// stubs, fake timers, and process env/cwd writes. Each gets a fresh graph; every
// other file shares one per worker, which keeps import cost off the critical
// path (halving the suite; see the package guide's verification table).
//
// Adding a file here is cheap. Leaving a mocking file out is not: its mock
// reaches whatever runs next in the same worker, and which file that is depends
// on worker assignment, so the breakage surfaces somewhere else, sometimes.
const ISOLATED_TESTS = [
	"test/suite/daemon-activations.test.ts", // HOME writes for project roots
	"test/suite/git-stamp-extension.test.ts", // vi.mock("node:child_process")
	"test/suite/web-clipboard.test.ts", // vi.stubGlobal + fake timers
	"test/suite/worker-lifecycle.test.ts", // PI_* env writes
	"web/**/*.test.{ts,tsx}", // document/localStorage stubs, render module mocks
];

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
			//
			// Two projects so `isolate: false` can be used where it is safe: files
			// that mutate module-level state keep a fresh graph each, everything else
			// reuses one per worker.
			projects: [
				{
					extends: true,
					test: {
						name: "shared",
						isolate: false,
						// Overriding `exclude` replaces the defaults, so the stock build and
						// dependency directories are listed again.
						exclude: [
							...ISOLATED_TESTS,
							"**/node_modules/**",
							"**/dist/**",
							"**/.{git,cache,output,temp}/**",
						],
					},
				},
				{ extends: true, test: { name: "isolated", include: ISOLATED_TESTS } },
			],
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
