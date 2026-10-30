// ============================================================================
// browserScheduler — the production FlushScheduler for the connection
// pipeline: the browser's rAF and visibility APIs. A separate module so the
// pipeline itself stays DOM-free and the cross-layer trace harness
// (test/suite/lifecycle-trace.test.ts) can run it in Node with deterministic
// fakes.
// ============================================================================

import type { FlushScheduler } from "./connectionPipeline.ts";

export function createBrowserFlushScheduler(): FlushScheduler {
	return {
		hidden: () => document.hidden,
		onVisibilityChange(listener: () => void): () => void {
			document.addEventListener("visibilitychange", listener);
			return () => document.removeEventListener("visibilitychange", listener);
		},
		scheduleFrame(flush: () => void): () => void {
			const handle = requestAnimationFrame(flush);
			return () => cancelAnimationFrame(handle);
		},
	};
}
