import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FauxProviderRegistration, FauxResponseStep } from "@earendil-works/pi-ai/compat";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AuthStorage, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Document, Patch, PatchOp } from "../../src/core/index.ts";
import { DocumentMirror, snapshotForWire } from "../../src/core/index.ts";
import { createManager, type Manager } from "../../src/host/index.ts";

export interface BridgeHarnessOptions {
	/** Absolute path to a coding-agent fixture. */
	fixturePath: string;
	/** Faux turn(s) to script. */
	responses?: FauxResponseStep[];
	/** Custom tools to register (e.g. streaming tools for tests). */
	customTools?: ToolDefinition[];
	/** Faux streaming speed (tokens/sec). Undefined = instant queueMicrotask. */
	tokensPerSecond?: number;
	/** Extra settings to merge into the in-memory SettingsManager. */
	settings?: Record<string, unknown>;
	/** Enable ADR 10 git identity stamps. Default: off (test seam). */
	gitStamps?: boolean;
	/** Run `git init` + an initial empty commit in tempCwd before creating
	 * the Manager, so stamp tests observe a real repository. */
	initGitRepo?: boolean;
}

export interface BridgeHarness {
	/** The Manager (replaces Host from ADR 02/03). */
	manager: Manager;
	faux: FauxProviderRegistration;
	/** The harness temp cwd — session files written here are switch targets. */
	tempCwd: string;
	/** Run git in tempCwd; resolves to trimmed stdout. */
	git: (...args: string[]) => Promise<string>;
	patches: Patch[];
	/** All ops from all patches, in order. */
	ops: PatchOp[];
	/** Check if any op matches a predicate (e.g. path starts with /entries/). */
	hasOp: (predicate: (op: PatchOp) => boolean) => boolean;
	cleanup: () => void;
}

export async function createBridgeHarness(opts: BridgeHarnessOptions): Promise<BridgeHarness> {
	const tempCwd = join(tmpdir(), `pi-bridge-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempCwd, { recursive: true });
	const tempAgentDir = join(tempCwd, "agent");
	mkdirSync(tempAgentDir, { recursive: true });
	const fixtureCopy = join(tempCwd, "session.jsonl");
	copyFileSync(opts.fixturePath, fixtureCopy);

	// 1. Faux provider + auth (order matters: register before model registry)
	const faux = registerFauxProvider({
		models: [{ id: "faux-1", reasoning: true }],
		tokensPerSecond: opts.tokensPerSecond,
	});
	faux.setResponses(opts.responses ?? []);
	const authStorage = AuthStorage.inMemory();
	const model = faux.getModel();
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage });
	await modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((m) => ({
			id: m.id,
			name: m.name,
			api: m.api,
			reasoning: m.reasoning,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			baseUrl: m.baseUrl,
		})),
	});
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		...(opts.settings ?? {}),
	} as Record<string, unknown>);

	// 2. Resume the fixture via cwdOverride.
	const sessionManager = SessionManager.open(fixtureCopy, undefined, tempCwd);

	const git = (...args: string[]): Promise<string> =>
		new Promise((resolve, reject) => {
			execFile("git", args, { cwd: tempCwd }, (err, stdout) =>
				err ? reject(err) : resolve(stdout.toString().trim()),
			);
		});
	if (opts.initGitRepo) {
		await git("init", "-q", "-b", "main");
		await git("config", "user.email", "bridge@test");
		await git("config", "user.name", "Bridge Test");
		await git("commit", "--allow-empty", "-q", "-m", "initial");
	}

	// 3. Create the Manager with injected services.
	const manager = await createManager({
		cwd: tempCwd,
		agentDir: tempAgentDir,
		modelRuntime,
		settingsManager,
		sessionManager,
		model,
		customTools: opts.customTools,
		// Default off: existing fixtures observe a non-repo temp cwd, and the
		// stamp observation would shift prompt-path timing for unrelated tests.
		gitStamps: opts.gitStamps ?? false,
	});

	const patches: Patch[] = [];
	const allOps: PatchOp[] = [];
	manager.onPatch((patch) => {
		patches.push(patch);
		allOps.push(...patch.ops);
	});

	return {
		manager,
		faux,
		tempCwd,
		git,
		patches,
		ops: allOps,
		hasOp: (predicate) => allOps.some(predicate),
		cleanup() {
			manager.dispose();
			faux.unregister();
			if (existsSync(tempCwd)) rmSync(tempCwd, { recursive: true, force: true });
		},
	};
}

// ============================================================================
// Mirror sync utilities — used by integration tests
// ============================================================================

/** Deep-equal (strict, no lazy-field tolerance). */
export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null) return a === b;
	if (typeof a !== typeof b) return false;
	if (typeof a !== "object") return false;

	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (!deepEqual(a[i], b[i])) return false;
		}
		return true;
	}
	if (Array.isArray(a) !== Array.isArray(b)) return false;

	const aKeys = Object.keys(a as Record<string, unknown>);
	const bKeys = Object.keys(b as Record<string, unknown>);
	if (aKeys.length !== bKeys.length) return false;
	for (const key of aKeys) {
		if (!(key in (b as Record<string, unknown>))) return false;
		if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
	}
	return true;
}

/**
 * Normalize a Document for comparison: snapshotForWire (strip lazy fields),
 * then JSON round-trip (eliminates undefined vs missing).
 */
export function normalizeForComparison(doc: Document): Document {
	return JSON.parse(JSON.stringify(snapshotForWire(doc))) as Document;
}

/** A BridgeHarness paired with a DocumentMirror subscribed to the Manager. */
export interface MirrorHarness {
	manager: Manager;
	faux: FauxProviderRegistration;
	mirror: DocumentMirror;
	cleanup: () => void;
}

/** Create a MirrorHarness: init mirror from canonical snapshot, subscribe to Manager patches. */
export function createMirrorHarness(bh: BridgeHarness): MirrorHarness {
	const mirror = new DocumentMirror();
	mirror.applyReplace(snapshotForWire(bh.manager.document));

	bh.manager.onPatch((patch) => {
		mirror.applyPatch(patch.ops);
	});

	return { manager: bh.manager, faux: bh.faux, mirror, cleanup: bh.cleanup };
}

/**
 * Assert the mirror matches the canonical document.
 * Normalizes both sides (strip lazy fields + JSON round-trip) before comparing.
 */
export function assertMirrorInSync(mh: MirrorHarness, label: string): void {
	const normMirror = normalizeForComparison(mh.mirror.document);
	const normCanonical = normalizeForComparison(mh.manager.document);

	if (!deepEqual(normMirror, normCanonical)) {
		const diffs: string[] = [];
		const allIds = new Set([...Object.keys(normCanonical.entries), ...Object.keys(normMirror.entries)]);
		for (const id of allIds) {
			const me = normMirror.entries[id];
			const ce = normCanonical.entries[id];
			if (!deepEqual(me, ce)) {
				diffs.push(`${label}: entry ${id}: ${me?.kind ?? "missing"} vs ${ce?.kind ?? "missing"}`);
			}
		}
		if (!deepEqual(normMirror.status, normCanonical.status)) {
			diffs.push(`${label}: status mismatch`);
		}
		throw new Error(`[${label}] Mirror out of sync:\n${diffs.join("\n")}`);
	}
}
