// ============================================================================
// CLI argument parsing.
//
// One invocation takes one of three roles. The default (`auto`) joins a running
// daemon as a Worker, or starts both in one process; the forced roles never
// change their mind. Project configuration (`--allow`) and the agent directory
// apply to the Worker half, the web listener (`--port`, `--web-root`, `--log`,
// `--dev`) to the Daemon half.
//
// `--worker-serve` and `--worker-spawn` are deployment plumbing, not part of the
// role model: the former is the entry a spawned child runs, the latter makes the
// Daemon spawn instead of hosting in-process. They stay undocumented.
// ============================================================================

/** The role this invocation takes. `auto` decides from the discovery probe. */
export type CliMode = "auto" | "daemon" | "worker";

export interface CliConfig {
	readonly mode: CliMode;
	/** The local discovery socket (`--socket`). */
	readonly socketPath: string;
	/** True when `--socket` was given: the internal child role requires an
	 * explicit path instead of silently binding the discovery address. */
	readonly socketExplicit: boolean;
	/** A remote daemon to register with (`--daemon`); implies worker mode. */
	readonly remoteDaemon: string | null;
	readonly allow: string[];
	readonly port: number | undefined;
	readonly webRoot: string | undefined;
	readonly logPath: string | undefined;
	readonly dev: boolean;
	readonly agentDir: string | undefined;
	/** Internal: run the socket-serving child role. */
	readonly workerServe: boolean;
	/** Internal: the Daemon spawns its Worker instead of hosting it. */
	readonly workerSpawn: boolean;
}

export type ParsedCli =
	| { readonly kind: "run"; readonly config: CliConfig }
	| { readonly kind: "help" }
	| { readonly kind: "version" }
	| { readonly kind: "error"; readonly message: string };

/** `--flag=value` and `--flag value` are both accepted: the documentation
 * writes the space form, muscle memory writes the other. */
function splitFlagValues(argv: readonly string[]): string[] {
	const out: string[] = [];
	for (const arg of argv) {
		const match = /^(--[a-z-]+)=(.*)$/.exec(arg);
		if (match) out.push(match[1] as string, match[2] as string);
		else out.push(arg);
	}
	return out;
}

const MODES: readonly CliMode[] = ["auto", "daemon", "worker"];

function isMode(value: string | undefined): value is CliMode {
	return value !== undefined && (MODES as readonly string[]).includes(value);
}

function parsePort(value: string | undefined): number | { error: string } {
	if (value === undefined) return { error: "--port needs a value" };
	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) return { error: `invalid --port: ${value}` };
	return port;
}

export function parseCliArgs(argv: readonly string[], defaults: { socketPath: string }): ParsedCli {
	const args = splitFlagValues(argv);
	const allow: string[] = [];
	let mode: CliMode = "auto";
	let modeForced = false;
	let socketPath = defaults.socketPath;
	let socketExplicit = false;
	let remoteDaemon: string | null = null;
	let port: number | undefined;
	let webRoot: string | undefined;
	let logPath: string | undefined;
	let dev = false;
	let agentDir: string | undefined;
	let workerServe = false;
	let workerSpawn = false;

	/** A flag whose value is the next argument. */
	const nextValue = (i: number, flag: string): string | { error: string } => {
		const value = args[i + 1];
		if (value === undefined || value.startsWith("--")) return { error: `${flag} needs a value` };
		return value;
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		switch (arg) {
			case "--mode": {
				const value = args[i + 1];
				if (!isMode(value)) return { kind: "error", message: `invalid --mode: ${String(value)}` };
				mode = value;
				modeForced = true;
				i++;
				break;
			}
			case "--socket": {
				const value = nextValue(i, "--socket");
				if (typeof value !== "string") return { kind: "error", message: value.error };
				socketPath = value;
				socketExplicit = true;
				i++;
				break;
			}
			case "--daemon": {
				const value = nextValue(i, "--daemon");
				if (typeof value !== "string") return { kind: "error", message: value.error };
				if (!/^wss?:\/\//.test(value)) {
					return { kind: "error", message: `--daemon needs a ws:// or wss:// URL, got ${value}` };
				}
				remoteDaemon = value;
				i++;
				break;
			}
			case "--allow": {
				const value = nextValue(i, "--allow");
				if (typeof value !== "string") return { kind: "error", message: value.error };
				allow.push(value);
				i++;
				break;
			}
			case "--port": {
				const raw = nextValue(i, "--port");
				if (typeof raw !== "string") return { kind: "error", message: raw.error };
				const parsed = parsePort(raw);
				if (typeof parsed !== "number") return { kind: "error", message: parsed.error };
				port = parsed;
				i++;
				break;
			}
			case "--web-root": {
				const value = nextValue(i, "--web-root");
				if (typeof value !== "string") return { kind: "error", message: value.error };
				webRoot = value;
				i++;
				break;
			}
			case "--log": {
				const value = nextValue(i, "--log");
				if (typeof value !== "string") return { kind: "error", message: value.error };
				logPath = value;
				i++;
				break;
			}
			case "--agent-dir": {
				const value = nextValue(i, "--agent-dir");
				if (typeof value !== "string") return { kind: "error", message: value.error };
				agentDir = value;
				i++;
				break;
			}
			case "--dev":
				dev = true;
				break;
			case "--worker-serve":
				workerServe = true;
				break;
			case "--worker-spawn":
				workerSpawn = true;
				break;
			case "--version":
			case "-v":
				return { kind: "version" };
			case "--help":
			case "-h":
				return { kind: "help" };
			default:
				return { kind: "error", message: `unknown argument: ${arg}` };
		}
	}

	if (remoteDaemon !== null) {
		if (mode === "daemon") {
			return { kind: "error", message: "--daemon cannot be combined with --mode=daemon" };
		}
		// A remote daemon is by definition a Worker registration.
		mode = "worker";
		modeForced = true;
	}
	if (workerServe && modeForced && mode !== "worker") {
		return { kind: "error", message: "--worker-serve is the Worker role" };
	}
	if (workerSpawn && mode === "worker") {
		return { kind: "error", message: "--worker-spawn is a Daemon deployment, not a role" };
	}
	if (workerServe && workerSpawn) {
		return { kind: "error", message: "--worker-serve and --worker-spawn are different processes" };
	}

	return {
		kind: "run",
		config: {
			mode,
			socketPath,
			socketExplicit,
			remoteDaemon,
			allow,
			port,
			webRoot,
			logPath,
			dev,
			agentDir,
			workerServe,
			workerSpawn,
		},
	};
}
