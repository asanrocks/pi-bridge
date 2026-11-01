// ============================================================================
// Startup discovery — which role this invocation takes.
//
// A local Worker needs a way to find a running Daemon without a port guess, so
// the default is one UNIX socket path (`$HOME/.pi/bridge.sock`, independent of
// pi's agent directory). The socket file is not proof of anything: a crashed
// daemon leaves the file behind, and an unrelated process can own the path.
// Every decision therefore comes from a probe that actually answers:
//
//   live    — a compatible daemon answered the handshake: join as a Worker.
//   absent  — nothing owns the path: bind a Daemon and host a Worker.
//   stale   — the file exists but nothing listens: remove it, then bind.
//   refused — the path is owned by something unsuitable: report, never retry
//             another address silently.
//
// Binding is the Daemon's own step, so a launch race is resolved where it
// actually happens: a daemon that loses the bind reports the path as taken, and
// the caller joins the winner instead of reporting a failure.
// ============================================================================

/** What a probe of the daemon socket found. A live answer carries the Daemon's
 * browser base URL, which the Worker cannot learn any other way, or null when
 * that Daemon has not bound its listener yet. */
export type ProbeResult =
	| { kind: "live"; web: string | null }
	| { kind: "absent" }
	| { kind: "stale" }
	| { kind: "refused"; reason: string };

export type StartupRole = { role: "worker"; web: string | null } | { role: "daemon" };

export interface DiscoverySteps {
	probe: () => Promise<ProbeResult>;
	/** Remove a socket file the probe proved is not listened on. */
	removeStale: () => void;
}

/**
 * Decide the role for a default (unforced) launch: join what answers, otherwise
 * take the socket. A refused path is reported as-is, never papered over by
 * picking another address.
 */
export async function resolveStartupRole(steps: DiscoverySteps): Promise<StartupRole | { error: string }> {
	const probe = await steps.probe();
	if (probe.kind === "live") return { role: "worker", web: probe.web };
	if (probe.kind === "refused") return { error: probe.reason };
	// Nothing answered: a leftover file must go before a Daemon can bind it.
	if (probe.kind === "stale") steps.removeStale();
	return { role: "daemon" };
}

/** True when a failed bind means another process just took the socket. */
export function isSocketTaken(err: unknown): boolean {
	return (err as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE";
}
