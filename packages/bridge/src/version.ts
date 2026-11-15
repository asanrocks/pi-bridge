// Placeholder: replaced at bundle time with the real build metadata.
// The bundle script (scripts/bundle-single.mjs) overwrites dist/version.js
// with real values before running esbuild.
//
// WARNING: npm run build alone produces these stubs — the resulting CLI reports
// "0.0.0 (dev, 1970-01-01)" and advertises the development build, which is what
// switches the browser's build check off. Run npm run build:binary for a real
// version, or npm run build:web for a stamped web bundle.
export const version = "0.0.0";
export const commit = "dev";
export const date = "1970-01-01";
// The pi runtime (@earendil-works/pi-coding-agent) version this build embeds.
export const piCore = "0.0.0";
// The wire identity every peer compares (core/build-identity.ts). Same shape as
// the generated module, so a checkout and a packaged build read one field.
export const buildStamp = { version, commit, date };
