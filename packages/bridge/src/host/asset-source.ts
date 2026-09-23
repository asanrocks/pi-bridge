// Asset source — the HTTP server's read-only view of the built web assets.
//
// One implementation reads a directory (development, `--web-root`); one reads
// the base64 map inlined at bundle time (the single-file binary). The server's
// routing is identical for both; only the I/O differs. Paths are leading-slash
// and query-free; the embedded source normalizes internally.
import { Buffer } from "node:buffer";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isContained } from "./projects.ts";

export type AssetRead = { kind: "file"; content: Buffer } | { kind: "missing" } | { kind: "forbidden" };

export interface AssetSource {
	/** Top-level names of the asset surface (files and directories). */
	rootNames(): Set<string>;
	/** `forbidden` is reachable only for a directory source escaping its root. */
	read(path: string): AssetRead;
}

/** Directory-backed source (development, `--web-root`). */
export function createDiskAssetSource(root: string): AssetSource {
	return {
		rootNames() {
			const names = new Set<string>();
			try {
				for (const name of readdirSync(root)) names.add(name);
			} catch {
				// No web root on disk (embedded-only distribution).
			}
			return names;
		},
		read(path) {
			const filePath = join(root, path);
			if (!isContained(root, filePath)) return { kind: "forbidden" };
			try {
				if (!statSync(filePath).isFile()) return { kind: "missing" };
				return { kind: "file", content: readFileSync(filePath) };
			} catch {
				return { kind: "missing" };
			}
		},
	};
}

/** Embedded-map source (single-file binary). */
export function createEmbeddedAssetSource(assets: Record<string, string>): AssetSource {
	return {
		rootNames() {
			const names = new Set<string>();
			for (const key of Object.keys(assets)) names.add(key.split("/")[0]);
			return names;
		},
		read(path) {
			const key = path === "/" ? "index.html" : path.replace(/^\//, "");
			const encoded = assets[key];
			if (encoded === undefined) return { kind: "missing" };
			return { kind: "file", content: Buffer.from(encoded, "base64") };
		},
	};
}
