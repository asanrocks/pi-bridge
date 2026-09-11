// Enable O(n) structural-sharing invariant checks in all bridge tests.
// These are gated behind a module-level flag (off by default in production).
import { __enableInvariantChecks } from "../src/core/index.ts";

__enableInvariantChecks();
