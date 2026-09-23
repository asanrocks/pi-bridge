// HTTP serving tests: SPA shell fallback — application routes
// (`/<projectId>`, `/<projectId>/<stem>`) and navigations to stale or unknown
// addresses — from both the disk web root and the embedded (single-file
// binary) asset map, plus the 404/403 boundaries. Regression coverage for the
// embedded path, where app routes previously fell through to a non-existent
// dist/web and returned 404, and for the stale-address navigation: a daemon
// restart with different Projects must load the shell so the client can
// resolve the address, not leave a 404 in the address bar.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Daemon, type DaemonOptions } from "../../src/host/index.ts";

interface Reply {
	status: number | undefined;
	contentType: string | undefined;
	body: string;
}

const daemons: Daemon[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
	while (daemons.length) {
		const d = daemons.pop();
		if (d) await d.dispose();
	}
	while (cleanups.length) cleanups.pop()?.();
});

function makeTempDir(label: string): string {
	const dir = join(tmpdir(), `pi-bridge-http-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

async function startDaemon(opts: DaemonOptions): Promise<number> {
	const daemon = new Daemon();
	daemons.push(daemon);
	await daemon.start(opts);
	const addr = daemon.address;
	if (!addr) throw new Error("daemon not listening");
	return addr.port;
}

/** Raw request (no fetch normalization) so path-escape cases hit the server
 * with the literal bytes a hostile client would send. */
function request(port: number, path: string, headers?: Record<string, string>): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const req = http.get({ host: "127.0.0.1", port, path, headers }, (res) => {
			let body = "";
			res.on("data", (chunk) => {
				body += chunk;
			});
			res.on("end", () => {
				resolve({ status: res.statusCode, contentType: res.headers["content-type"], body });
			});
		});
		req.on("error", reject);
	});
}

/** App routes for a project id: the Project home and one session, including a
 * nested (multi-segment) stem. */
const appRoutes = (pid: string) => [`/${pid}`, `/${pid}/2026-01-01T00-00-00-000Z_sess`, `/${pid}/nested/stem`];

describe("HTTP serving", () => {
	it("serves the SPA shell for app routes from the disk web root", async () => {
		const project = makeTempDir("disk-proj");
		const webRoot = makeTempDir("disk-web");
		writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>DISK-SHELL</title>");
		writeFileSync(join(webRoot, "app.js"), "console.log(1)");
		const port = await startDaemon({ agentDir: makeTempDir("disk-agent"), allow: [project], webRoot });
		const pid = basename(project).toLowerCase();

		for (const path of appRoutes(pid)) {
			const res = await request(port, path);
			expect(res.status, path).toBe(200);
			expect(res.contentType, path).toContain("text/html");
			expect(res.body, path).toContain("DISK-SHELL");
		}

		const asset = await request(port, "/app.js");
		expect(asset.status).toBe(200);
		expect(asset.contentType).toContain("text/javascript");
		expect(asset.body).toBe("console.log(1)");
	});

	it("serves the SPA shell for app routes from embedded assets (single-file binary path)", async () => {
		const project = makeTempDir("emb-proj");
		// An empty web root isolates the test from any real dist/web on disk:
		// if the embedded path fails to serve, the request 404s.
		const webRoot = makeTempDir("emb-web");
		const embeddedAssets = {
			"index.html": Buffer.from("<!doctype html><title>EMBEDDED-SHELL</title>").toString("base64"),
			"assets/app.js": Buffer.from("console.log(2)").toString("base64"),
		};
		const port = await startDaemon({
			agentDir: makeTempDir("emb-agent"),
			allow: [project],
			webRoot,
			embeddedAssets,
		});
		const pid = basename(project).toLowerCase();

		for (const path of ["/", ...appRoutes(pid)]) {
			const res = await request(port, path);
			expect(res.status, path).toBe(200);
			expect(res.contentType, path).toContain("text/html");
			expect(res.body, path).toContain("EMBEDDED-SHELL");
		}

		const asset = await request(port, "/assets/app.js");
		expect(asset.status).toBe(200);
		expect(asset.contentType).toContain("text/javascript");
		expect(asset.body).toBe("console.log(2)");

		// A navigation to a stale address falls back to the embedded shell.
		const stale = await request(port, "/old-project/some/stem", { accept: "text/html,*/*" });
		expect(stale.status).toBe(200);
		expect(stale.body).toContain("EMBEDDED-SHELL");
	});

	it("returns 404 for non-navigation fetches of unknown paths, 403 for path escapes", async () => {
		const project = makeTempDir("bound-proj");
		const rootParent = makeTempDir("bound-parent");
		const webRoot = join(rootParent, "web");
		mkdirSync(webRoot);
		writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
		writeFileSync(join(rootParent, "secret.txt"), "outside");
		const port = await startDaemon({
			agentDir: makeTempDir("bound-agent"),
			allow: [project],
			webRoot,
		});

		// A fetch (no `Accept: text/html`) with no file behind it stays 404 — a
		// missing asset must not masquerade as the shell.
		expect((await request(port, "/missing.js")).status).toBe(404);
		expect((await request(port, "/not-a-project")).status).toBe(404);
		expect((await request(port, "/not-a-project/some/stem")).status).toBe(404);
		// A directory (vite's `assets/` output) is not a file: it must fall
		// through to the 404, not be read as one.
		mkdirSync(join(webRoot, "assets"));
		expect((await request(port, "/assets")).status).toBe(404);
		// Literal `..` resolves outside the web root — containment must reject
		// it before any read (ADR 11 security boundary).
		expect((await request(port, "/../secret.txt")).status).toBe(403);
		// A plain string-prefix pass would also leak sibling directories whose
		// names extend the root's (`web-x` vs `web`).
		mkdirSync(join(rootParent, "web-x"));
		writeFileSync(join(rootParent, "web-x", "secret.txt"), "outside");
		expect((await request(port, "/../web-x/secret.txt")).status).toBe(403);
	});

	it("serves the SPA shell for navigations to stale or unknown addresses", async () => {
		// The daemon restarted with different Projects: a bookmarked
		// `/<oldProject>/<stem>` must load the shell so the client resolves the
		// address down to the launcher — a bare 404 in the address bar is the
		// failure this covers.
		const project = makeTempDir("nav-proj");
		const webRoot = makeTempDir("nav-web");
		writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>NAV-SHELL</title>");
		const port = await startDaemon({ agentDir: makeTempDir("nav-agent"), allow: [project], webRoot });

		for (const path of ["/old-project", "/old-project/some/stem", "/missing.js"]) {
			const res = await request(port, path, { accept: "text/html,application/xhtml+xml,*/*;q=0.1" });
			expect(res.status, path).toBe(200);
			expect(res.contentType, path).toContain("text/html");
			expect(res.body, path).toContain("NAV-SHELL");
		}
	});
});
