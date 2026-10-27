import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// The live-service suite lives in test/e2e and must never run here.
		exclude: [...configDefaults.exclude, "test/e2e/**"],
	},
	// Workspace dependencies resolve through their `source` export condition, so a
	// test never needs a stale `dist/`.
	resolve: { conditions: ["source"] },
});
