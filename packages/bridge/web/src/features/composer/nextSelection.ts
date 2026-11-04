// ============================================================================
// nextSelection — the stateless client API's send-time heuristic, shared by
// the composer surfaces (what the picker shows) and the commit path (what a
// send carries). There is no server-side model state to read back: a send
// carries its selection, and everything else is derived here.
//
// The heuristic: the local pick (the picker's session-scoped choice, consumed
// by the send that carries it), else inheritance from the path the send
// continues — an edit forks at the edited message's parent, a compose
// continues from the live leaf. Inheritance is the last `model_change` the
// path records, else the producer of the path's last assistant message,
// validated against the daemon catalogue so a model that is gone degrades to
// "carry nothing" instead of failing the send (the catalogue is
// auth-filtered, so a provider that lost its credentials is absent too). The
// display falls back to the session's live model — the model an uncarried
// send runs on.
//
// A carry is applied by the worker only while the session is idle, so a send
// admitted mid-turn (a steer) carries nothing here either: the turn in flight
// keeps the model it started on, and the pick survives for the next idle send
// instead of being spent on a steer that could not use it.
// ============================================================================

import type { Document, ModelInfo, ModelRef } from "../../../../src/core/index.ts";
import { inheritModelForPath, inheritThinkingLevelForPath } from "../../../../src/viewmodel/index.ts";
import type { ComposerDraft, SelectionPick } from "../../infra/state/composer.ts";
import { clampToSupportedLevels } from "./thinkingLevels.ts";

/** What the composer shows and what a send carries. */
export interface NextSelection {
	/** The picker's button and selected row. Null = no model (nothing picked,
	 * inherited, or live). */
	model: ModelRef | null;
	/** The model a send carries. Undefined = carry nothing; the worker keeps
	 * the session's current selection in force. */
	carryModel: ModelRef | undefined;
	/** The thinking-level row's value, clamped to the display model's
	 * supported levels. */
	level: string;
	/** The level a send carries. Undefined = carry nothing. */
	carryLevel: string | undefined;
}

/** A reference the daemon's catalogue still resolves — the guard that keeps
 * inheritance from carrying a model that is gone. */
function knownModel(models: ModelInfo[], ref: ModelRef | null): ModelRef | null {
	if (!ref) return null;
	return models.some((m) => m.provider === ref.provider && m.id === ref.modelId) ? ref : null;
}

export function nextSelectionOf(input: {
	document: Document;
	draft: ComposerDraft;
	pick: SelectionPick | null;
	models: ModelInfo[];
}): NextSelection {
	const { document, draft, pick, models } = input;
	// The path a send continues: an edit forks at the edited message's parent,
	// so it inherits what was in force when that message was sent; a compose
	// continues from the live leaf (sends are locked while peeking at another
	// branch, so the live leaf is what a send extends).
	const forkAt = draft.kind === "edit" ? (document.entries[draft.entryId]?.parentId ?? null) : document.status.leafId;
	const inheritedModel = knownModel(models, inheritModelForPath(document.entries, forkAt));
	const pickedModel = pick?.model ? knownModel(models, pick.model) : null;
	const carryModel = pickedModel ?? inheritedModel ?? undefined;
	const statusModel = document.status.model;
	const model = carryModel ?? (statusModel.modelId !== "" ? statusModel : null);
	const carryLevel = pick?.thinkingLevel ?? inheritThinkingLevelForPath(document.entries, forkAt) ?? undefined;
	const level = carryLevel ?? document.status.thinkingLevel;
	const info = model ? models.find((m) => m.provider === model.provider && m.id === model.modelId) : undefined;
	// The clamp is the single authority on what a model can support: the
	// display and the carry both take this value, so the wire never names a
	// level the picker is not already showing.
	const clampedLevel = clampToSupportedLevels(level, info?.supportedThinkingLevels);
	// A busy session (streaming or compacting) applies no carry: a steer keeps
	// the running model, and the pick is not spent on it.
	const carries = !(document.status.isStreaming || document.status.isCompacting);
	return {
		model,
		carryModel: carries ? carryModel : undefined,
		level: clampedLevel,
		carryLevel: carries && carryLevel !== undefined ? clampedLevel : undefined,
	};
}
