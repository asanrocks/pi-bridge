// HTTP serving tests. The daemon owns a small asset surface: a request whose
// first path segment names a top-level entry of the web build is a resource
// (miss -> 404, traversal -> 403); every other path is a client address and
// gets the shell. Covered for both asset sources — the disk web root and the
// embedded (single-file binary) map — which share the routing and differ only
// in I/O.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Daemon, type DaemonOptions } from "../../src/host/index.ts";

interface Reply {
	status: number | undefined;
	contentType: string | undefined;
	cacheControl: string | undefined;
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
function request(port: number, path: string): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
			let body = "";
			res.on("data", (chunk) => {
				body += chunk;
			});
			res.on("end", () => {
				resolve({
					status: res.statusCode,
					contentType: res.headers["content-type"],
					cacheControl: res.headers["cache-control"],
					body,
				});
			});
		});
		req.on("error", reject);
	});
}

/** Address-shaped paths (the client resolves them): the Project home, one
 * session with a nested stem, the alias, and an unknown first segment. */
const addressRoutes = (pid: string) => [
	"/",
	`/${pid}`,
	`/${pid}/2026-01-01T00-00-00-000Z_sess`,
	`/${pid}/nested/stem`,
	"/@latest",
	"/%40latest",
	"/not-a-project",
	"///",
];

describe("HTTP serving", () => {
	it("serves the shell for addresses and files for resources from the disk web root", async () => {
		const project = makeTempDir("disk-proj");
		const webRoot = makeTempDir("disk-web");
		writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>DISK-SHELL</title>");
		writeFileSync(join(webRoot, "app.js"), "console.log(1)");
		mkdirSync(join(webRoot, "assets"));
		writeFileSync(join(webRoot, "assets", "index-abc.js"), "console.log(2)");
		const port = await startDaemon({ agentDir: makeTempDir("disk-agent"), allow: [project], webRoot });
		const pid = basename(project).toLowerCase();

		const shell = await request(port, `/${pid}`);
		expect(shell.body).toContain("DISK-SHELL");
		expect(shell.cacheControl).toBe("no-cache");
		for (const path of addressRoutes(pid)) {
			const res = await request(port, path);
			expect(res.status, path).toBe(200);
			expect(res.contentType, path).toContain("text/html");
			expect(res.body, path).toContain("DISK-SHELL");
			expect(res.cacheControl, path).toBe("no-cache");
		}

		const rootFile = await request(port, "/app.js");
		expect(rootFile.status).toBe(200);
		expect(rootFile.contentType).toContain("text/javascript");
		expect(rootFile.body).toBe("console.log(1)");

		const hashed = await request(port, "/assets/index-abc.js");
		expect(hashed.status).toBe(200);
		expect(hashed.body).toBe("console.log(2)");
		expect(hashed.cacheControl).toContain("immutable");

		expect((await request(port, "/assets/missing.js")).status).toBe(404);
	});

	it("serves the shell for addresses and files for resources from embedded assets (single-file binary path)", async () => {
		const project = makeTempDir("emb-proj");
		// An empty web root isolates the test from any real dist/web on disk.
		const webRoot = makeTempDir("emb-web");
		const embeddedAssets = {
			"index.html": Buffer.from("<!doctype html><title>EMBEDDED-SHELL</title>").toString("base64"),
			"assets/index-abc.js": Buffer.from("console.log(3)").toString("base64"),
		};
		const port = await startDaemon({
			agentDir: makeTempDir("emb-agent"),
			allow: [project],
			webRoot,
			embeddedAssets,
		});
		const pid = basename(project).toLowerCase();

		for (const path of addressRoutes(pid)) {
			const res = await request(port, path);
			expect(res.status, path).toBe(200);
			expect(res.contentType, path).toContain("text/html");
			expect(res.body, path).toContain("EMBEDDED-SHELL");
			expect(res.cacheControl, path).toBe("no-cache");
		}

		const hashed = await request(port, "/assets/index-abc.js");
		expect(hashed.status).toBe(200);
		expect(hashed.body).toBe("console.log(3)");
		expect(hashed.cacheControl).toContain("immutable");

		expect((await request(port, "/assets/missing.js")).status).toBe(404);
	});

	it("rejects traversal under a resource root and 404s resource misses", async () => {
		const project = makeTempDir("bound-proj");
		const rootParent = makeTempDir("bound-parent");
		const webRoot = join(rootParent, "web");
		mkdirSync(join(webRoot, "assets"), { recursive: true });
		writeFileSync(join(webRoot, "index.html"), "<!doctype html>SHELL");
		writeFileSync(join(webRoot, "assets", "app.js"), "ok");
		writeFileSync(join(rootParent, "secret.txt"), "outside");
		const port = await startDaemon({
			agentDir: makeTempDir("bound-agent"),
			allow: [project],
			webRoot,
		});

		// A resource miss inside the server's surface is a 404.
		expect((await request(port, "/assets/missing.js")).status).toBe(404);
		// Literal `..` under a root resolves outside the web root — containment
		// must reject it before any read (ADR 11 security boundary).
		expect((await request(port, "/assets/../../secret.txt")).status).toBe(403);
		// A plain string-prefix pass would also leak sibling directories whose
		// names extend the root's (`web-x` vs `web`).
		mkdirSync(join(rootParent, "web-x"));
		writeFileSync(join(rootParent, "web-x", "secret.txt"), "outside");
		expect((await request(port, "/assets/../../web-x/secret.txt")).status).toBe(403);
		// Outside the asset surface there is no file read: a path outside every
		// root (including a literal `..`) is just an address and gets the shell.
		for (const path of ["/secret.txt", "/../secret.txt"]) {
			const res = await request(port, path);
			expect(res.status, path).toBe(200);
			expect(res.body, path).toContain("SHELL");
		}
	});
});
