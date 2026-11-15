// ============================================================================
// buildStamp — the identity this app bundle was built with.
//
// `web/vite.config.ts` substitutes `__PI_BRIDGE_BUILD__` at build time with the
// same stamp the Daemon reports (scripts/build-stamp.mjs), so the two halves of
// one deployment compare equal. Nothing is imported at runtime: the object is
// compiled in, which is what lets a tab keep speaking its own build's dialect
// while the Daemon it reaches has moved on.
//
// A bundle built without the stamp step (development mode, or a unit test) reads
// the marker stamp, and the comparison turns itself off — a developer's loop is
// the developer's responsibility, and a panel that nags on every rebuild is a
// panel nobody reads.
// ============================================================================

import { type BuildStamp, DEV_BUILD } from "../../../../src/core/index.ts";

declare const __PI_BRIDGE_BUILD__: BuildStamp;

export const APP_BUILD: BuildStamp = typeof __PI_BRIDGE_BUILD__ === "undefined" ? DEV_BUILD : __PI_BRIDGE_BUILD__;
