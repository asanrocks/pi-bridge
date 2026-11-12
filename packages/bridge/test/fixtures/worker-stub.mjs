// A stand-in Worker for the spawn-plumbing test.
//
// The real Worker role is covered by its own modules; this fixture exercises
// only what the Daemon's spawn mode does: start a child, wait for its socket,
// accept its handshake, and stop it on dispose. Plain JavaScript means the test
// needs no build.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

// The stub must greet with the package's own protocol version: the Daemon
// refuses a dialect it does not speak, so a bump would turn these spawn tests
// into protocol-mismatch tests. The fixture runs as a plain Node child and
// cannot import the TypeScript constant, so it reads it from the source.
function protocolVersion() {
	const source = readFileSync(new URL("../../src/core/protocol-version.ts", import.meta.url), "utf8");
	const match = /PROTOCOL_VERSION = (\d+)/.exec(source);
	if (match === null) throw new Error("worker-stub: cannot read PROTOCOL_VERSION");
	return Number(match[1]);
}

const args = process.argv.slice(2);
const socketIndex = args.indexOf("--socket");
const socketPath = socketIndex >= 0 ? args[socketIndex + 1] : undefined;
if (socketPath === undefined) {
	process.stderr.write("worker-stub: missing --socket\n");
	process.exit(2);
}

const wss = new WebSocketServer({ noServer: true });
const server = createServer();
server.on("upgrade", (request, socket, head) => {
	wss.handleUpgrade(request, socket, head, (ws) => {
		ws.send(
			JSON.stringify({
				kind: "hello",
				protocol: protocolVersion(),
				registration: { id: "stub", incarnation: "stub-inc", generation: 1 },
				info: {
					projects: [{ id: "alpha", cwd: "/tmp/alpha", defaultModel: null, defaultThinkingLevel: null }],
					models: [],
					pinnedModels: [],
					visibleModels: [],
					thinkingLevels: ["off"],
				},
			}),
		);
		ws.on("message", (data) => {
			const frame = JSON.parse(data.toString());
			ws.send(JSON.stringify({ id: frame.id, ok: true, result: null }));
			if (frame.kind === "shutdown") {
				ws.close();
				server.close();
				setTimeout(() => process.exit(0), 10);
			}
		});
	});
});
server.listen(socketPath, () => process.stdout.write("worker-stub listening\n"));
