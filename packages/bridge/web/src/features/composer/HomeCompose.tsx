// ============================================================================
// HomeCompose — the Project home's compose surface: the same ComposeCard as
// the session dock, centered and always expanded ("compose first, browse
// second"). No dock machinery: no collapsed bar, no turn wiring, no ledger —
// `leftControls` is empty and there is no Stop. The commit path is
// newSession (ADR 12 slice): text + attachments + the pre-session model
// choice are admitted server-side before attach, so the session the client
// navigates into is already streaming.
//
// Draft: the store draft scoped to the project (draftPersistence keys
// `p:<projectId>`), so an unsent prompt survives navigation and reloads.
// Model + thinking level: per-project pre-session picks persisted to one
// localStorage slot; unset means "the daemon-resolved default" and sends
// nothing with newSession, so the daemon keeps resolving.
// ============================================================================

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ImageContent, ModelInfo, ModelRef } from "../../../../src/core/index.ts";
import { findNextModel } from "../../../../src/viewmodel/index.ts";
import { useStore } from "../../infra/state/store.tsx";
import { ComposeCard } from "./ComposeCard.tsx";
import styles from "./HomeCompose.module.css";
import { useComposeCapabilities } from "./useComposeCapabilities.ts";

const MODEL_KEY_PREFIX = "pi-bridge:home-model:";

/** The persisted pre-session pick for one Project: a model plus an optional
 * thinking level. */
interface HomePick {
	provider: string;
	modelId: string;
	thinkingLevel?: string;
}

function loadHomePick(projectId: string): HomePick | null {
	try {
		const raw = localStorage.getItem(MODEL_KEY_PREFIX + projectId);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as HomePick;
		if (typeof parsed.provider !== "string" || typeof parsed.modelId !== "string") return null;
		return parsed;
	} catch {
		return null; // private mode / corrupt slot — degrade to the default
	}
}

function saveHomePick(projectId: string, pick: HomePick | null): void {
	try {
		if (pick) localStorage.setItem(MODEL_KEY_PREFIX + projectId, JSON.stringify(pick));
		else localStorage.removeItem(MODEL_KEY_PREFIX + projectId);
	} catch {
		// Quota / private mode — the in-memory slot stands for this visit.
	}
}

export const HomeCompose = memo(function HomeCompose({
	projectId,
	models,
	defaultModel,
	defaultThinkingLevel,
	connected,
	onNewSession,
}: {
	projectId: string;
	models: ModelInfo[];
	/** The model a fresh session resolves to (ProjectInfo.defaultModel from
	 * getDaemonInfo) — display only. The send still omits `model` when unset,
	 * so the daemon keeps resolving (settings/auth changes stay live). */
	defaultModel: ModelRef | null;
	/** The thinking level that same resolution yields — display-only like
	 * `defaultModel`; the bar seeds from it until the user picks. */
	defaultThinkingLevel: string | null;
	connected: boolean;
	/** Send the first prompt of a new session. Resolves true on success —
	 * the draft is kept for retry on failure. */
	onNewSession: (
		projectId: string,
		text: string,
		images?: ImageContent[],
		model?: ModelRef,
		thinkingLevel?: string,
	) => Promise<boolean>;
}) {
	const draft = useStore((s) => s.draft);
	const setDraftText = useStore((s) => s.setDraftText);
	const clearDraft = useStore((s) => s.clearDraft);
	const text = draft.kind === "idle" ? "" : draft.text;

	const [pick, setPick] = useState<HomePick | null>(() => loadHomePick(projectId));
	const [sending, setSending] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const capabilities = useComposeCapabilities({ textareaRef });

	// Landing on the Project home is a come-to-type gesture — focus the card.
	useEffect(() => {
		textareaRef.current?.focus();
	}, []);

	// The slot is per-project; switching projects re-reads it.
	useEffect(() => {
		setPick(loadHomePick(projectId));
	}, [projectId]);

	// Effective = the explicit picks, else the daemon-reported defaults (shown
	// in the button, the level row, and the picker's selected row; "none" when
	// nothing is available). Only the explicit picks are sent with newSession.
	// A level-only pick carries no model — the derivation must yield null so
	// the daemon default (not a {undefined, undefined} object) shows through.
	const model = pick?.provider && pick?.modelId ? { provider: pick.provider, modelId: pick.modelId } : null;
	const effectiveModel = model ?? defaultModel;
	const effectiveLevel = pick?.thinkingLevel ?? defaultThinkingLevel ?? "";

	const thinkingLevels = useStore((s) => s.thinkingLevels);

	const handleSetModel = useCallback(
		(provider: string, modelId: string) => {
			const next: HomePick = { provider, modelId };
			// Keep the level pick only if the new model supports it — otherwise
			// drop it and fall back to the Project default (pi clamps server-side
			// too; this keeps the display honest).
			const supported = models.find((m) => m.provider === provider && m.id === modelId)?.supportedThinkingLevels;
			const level = pick?.thinkingLevel;
			if (level && (!supported || supported.includes(level))) next.thinkingLevel = level;
			setPick(next);
			saveHomePick(projectId, next);
		},
		[projectId, models, pick],
	);

	const handleSetThinkingLevel = useCallback(
		(level: string) => {
			// Picking a level without a model pins the level only: the send then
			// carries the level while the daemon resolves the model.
			const next: HomePick = pick ? { ...pick, thinkingLevel: level } : ({ thinkingLevel: level } as HomePick);
			setPick(next);
			saveHomePick(projectId, next);
		},
		[projectId, pick],
	);

	// Ctrl+P cycles the same provider-deduped list the session dock uses;
	// cycling from the (unpicked) default starts at the default's position.
	const cycleModels = useMemo(() => {
		const seen = new Set<string>();
		return models.filter((m) => {
			if (seen.has(m.provider)) return false;
			seen.add(m.provider);
			return true;
		});
	}, [models]);

	const handleCycleModel = useCallback(
		(direction: "forward" | "backward") => {
			const current: ModelRef = effectiveModel ?? {
				provider: cycleModels[0]?.provider ?? "",
				modelId: cycleModels[0]?.id ?? "",
			};
			const next = findNextModel(cycleModels, current, direction);
			if (next && !(next.provider === current.provider && next.id === current.modelId)) {
				handleSetModel(next.provider, next.id);
			}
		},
		[effectiveModel, cycleModels, handleSetModel],
	);

	const handleCommit = useCallback(async () => {
		if (sending) return;
		const images = capabilities.images;
		if (!text.trim() && images.length === 0) return;
		setSending(true);
		let ok = false;
		try {
			ok = await onNewSession(
				projectId,
				text,
				images.length > 0 ? images : undefined,
				model ?? undefined,
				pick?.thinkingLevel,
			);
		} finally {
			setSending(false);
		}
		if (ok) {
			clearDraft();
		} else {
			// Failed create: keep the draft for retry and put the caret back —
			// the textarea stays enabled through the send.
			textareaRef.current?.focus();
		}
	}, [sending, text, capabilities.images, model, pick, onNewSession, projectId, clearDraft]);

	return (
		<div className={styles.home}>
			<ComposeCard
				{...capabilities.cardProps}
				value={text}
				onChange={setDraftText}
				onCommit={handleCommit}
				connected={connected}
				placeholder={`Send a prompt to ${projectId}…`}
				sending={sending}
				textareaRef={textareaRef}
				model={effectiveModel}
				models={models}
				scopedModels={[]}
				thinkingLevel={effectiveLevel}
				thinkingLevels={thinkingLevels}
				onSetModel={handleSetModel}
				onSetThinkingLevel={handleSetThinkingLevel}
				onCycleModel={handleCycleModel}
			/>
			<div className={styles.hint}>Enter starts a new session · Shift+Enter for a new line</div>
		</div>
	);
});
