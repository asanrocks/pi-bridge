import { defineConfig } from "vitest/config";

// The live-service suite is opt-in: `PI_ASR_E2E=1 npm run test:e2e`.
export default defineConfig({
	test: {
		include: ["test/e2e/**/*.e2e.test.ts"],
		testTimeout: 120_000,
		hookTimeout: 60_000,
		// Sequential: one session at a time keeps the endpointing predictable.
		fileParallelism: false,
	},
});
