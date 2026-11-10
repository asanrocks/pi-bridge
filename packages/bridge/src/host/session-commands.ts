// ============================================================================
// Session commands — the typed command surface one attached Session exposes.
//
// A Connection does not hold a Session's runtime, and after the Worker split it
// does not hold a capability either: it holds a **Session target** (the address,
// the durable session id, the Worker registration, and the activation
// generation) and a command surface bound to it. Every command names the
// Activation it was composed for, so a target whose registration ended is
// refused by the owner rather than retargeted at its successor — a property the
// Daemon gets locally and a remote link gets by sending the same target.
//
// The surface is what a verb handler may call, and nothing else: no Manager, no
// admission object, no generic "run this against the runtime" escape. `pull`
// belongs here too because it is an attachment-bound read of the same stream.
// ============================================================================

import type { ImageContent, ModelRef, PullRequestItem } from "../core/index.ts";
import type { SessionTarget, WorkerObservation, WorkerPulledValue, WorkerService } from "./worker-contract.ts";

/** The typed commands of one Session, unbound: what any owner of a runtime can
 * offer. A Worker implements it per target; an actor admission implements it
 * for the registration it belongs to. The prompt carries the send's model
 * selection (the stateless client API) — there is no separate model verb. */
export interface SessionCommandSurface {
	prompt(text: string, images?: ImageContent[], model?: ModelRef, thinkingLevel?: string): Promise<void>;
	abort(): Promise<void>;
	discardSteer(): Promise<void>;
	/** Compact the context now; returns pi's token estimates. A serialized
	 * mutation, not a turn: it refuses while a turn is in flight (pi's manual
	 * compaction aborts first) and reports pi's reasons on failure. */
	compact(customInstructions?: string): Promise<{ tokensBefore: number; estimatedTokensAfter?: number }>;
	renameSession(name: string): Promise<void>;
	setLabel(entryId: string, label: string): Promise<void>;
	navigate(entryId: string | null): Promise<void>;
	recoverTurn(): Promise<"retry" | "continue">;
	/** Read lazy values through this Session's observation. */
	pull(requests: readonly PullRequestItem[]): Promise<WorkerPulledValue[]>;
}

/** The commands of one attachment: a target plus the surface that serves it. */
export interface SessionCommands extends SessionCommandSurface {
	readonly target: SessionTarget;
}

/** Bind a command surface to the target it serves. The binding is identity,
 * not liveness: admission (and therefore staleness) is decided by the surface's
 * owner, which is the only component that can see the registration's state. */
export function bindSessionCommands(target: SessionTarget, surface: SessionCommandSurface): SessionCommands {
	return {
		target,
		prompt: (text, images, model, thinkingLevel) => surface.prompt(text, images, model, thinkingLevel),
		abort: () => surface.abort(),
		discardSteer: () => surface.discardSteer(),
		compact: (customInstructions) => surface.compact(customInstructions),
		renameSession: (name) => surface.renameSession(name),
		setLabel: (entryId, label) => surface.setLabel(entryId, label),
		navigate: (entryId) => surface.navigate(entryId),
		recoverTurn: () => surface.recoverTurn(),
		pull: (requests) => surface.pull(requests),
	};
}

/** The Worker's view of one target: its contract methods take the target, so
 * the adapter re-supplies the bound one. This is the local Daemon's binding;
 * a remote Daemon's link client supplies the same shape over the socket. */
export function bindWorkerCommands(
	worker: WorkerService,
	target: SessionTarget,
	observation: WorkerObservation,
): SessionCommands {
	const surface: SessionCommandSurface = {
		prompt: (text, images, model, thinkingLevel) => worker.prompt(target, text, images, model, thinkingLevel),
		abort: () => worker.abort(target),
		discardSteer: () => worker.discardSteer(target),
		compact: (customInstructions) => worker.compact(target, customInstructions),
		renameSession: (name) => worker.renameSession(target, name),
		setLabel: (entryId, label) => worker.setLabel(target, entryId, label),
		navigate: (entryId) => worker.navigate(target, entryId),
		recoverTurn: () => worker.recoverTurn(target),
		pull: (requests) => observation.pull(requests),
	};
	return bindSessionCommands(target, surface);
}
