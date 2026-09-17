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
// Model: a per-project pre-session slot persisted to localStorage; null
// means "the daemon/session default" and sends no model with newSession.
// Thinking level is session state — the picker's level row is hidden here
// until newSession grows a level param.
// ============================================================================

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ImageContent, ModelInfo, ModelRef } from "../../../../src/core/index.ts";
import { findNextModel } from "../../../../src/viewmodel/index.ts";
import { useStore } from "../../infra/store.tsx";
import { ComposeCard } from "./ComposeCard.tsx";
import styles from "./HomeCompose.module.css";
import { useImageAttachments } from "./useImageAttachments.ts";
import { usePathCompletion } from "./usePathCompletion.tsx";

const MODEL_KEY_PREFIX = "pi-bridge:home-model:";

function loadHomeModel(projectId: string): ModelRef | null {
	try {
		const raw = localStorage.getItem(MODEL_KEY_PREFIX + projectId);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as ModelRef;
		if (typeof parsed.provider !== "string" || typeof parsed.modelId !== "string") return null;
		return parsed;
	} catch {
		return null; // private mode / corrupt slot — degrade to the default
	}
}

function saveHomeModel(projectId: string, model: ModelRef | null): void {
	try {
		if (model) localStorage.setItem(MODEL_KEY_PREFIX + projectId, JSON.stringify(model));
		else localStorage.removeItem(MODEL_KEY_PREFIX + projectId);
	} catch {
		// Quota / private mode — the in-memory slot stands for this visit.
	}
}

export const HomeCompose = memo(function HomeCompose({
	projectId,
	models,
	connected,
	onNewSession,
}: {
	projectId: string;
	models: ModelInfo[];
	connected: boolean;
	/** Send the first prompt of a new session. Resolves true on success —
	 * the draft is kept for retry on failure. */
	onNewSession: (projectId: string, text: string, images?: ImageContent[], model?: ModelRef) => Promise<boolean>;
}) {
	const draft = useStore((s) => s.draft);
	const setDraftText = useStore((s) => s.setDraftText);
	const clearDraft = useStore((s) => s.clearDraft);
	const text = draft.kind === "idle" ? "" : draft.text;

	const [model, setModel] = useState<ModelRef | null>(() => loadHomeModel(projectId));
	const [sending, setSending] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const attachments = useImageAttachments();
	const completion = usePathCompletion({
		value: text,
		onChange: setDraftText,
		textareaRef,
		// Deferred: listFiles is attachment-bound; completion on the home
		// waits for the ADR 12 re-address to the Project cwd.
		complete: async () => [],
	});

	// Landing on the Project home is a come-to-type gesture — focus the card.
	useEffect(() => {
		textareaRef.current?.focus();
	}, []);

	// The slot is per-project; switching projects re-reads it.
	useEffect(() => {
		setModel(loadHomeModel(projectId));
	}, [projectId]);

	const handleSetModel = useCallback(
		(provider: string, modelId: string) => {
			const next = { provider, modelId };
			setModel(next);
			saveHomeModel(projectId, next);
		},
		[projectId],
	);

	// Ctrl+P cycles the same provider-deduped list the session dock uses.
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
			const current: ModelRef = model ?? {
				provider: cycleModels[0]?.provider ?? "",
				modelId: cycleModels[0]?.id ?? "",
			};
			const next = findNextModel(cycleModels, current, direction);
			if (next) handleSetModel(next.provider, next.id);
		},
		[model, cycleModels, handleSetModel],
	);

	const handleCommit = useCallback(async () => {
		if (sending) return;
		const images = attachments.images;
		if (!text.trim() && images.length === 0) return;
		setSending(true);
		let ok = false;
		try {
			ok = await onNewSession(projectId, text, images.length > 0 ? images : undefined, model ?? undefined);
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
	}, [sending, text, attachments.images, model, onNewSession, projectId, clearDraft]);

	return (
		<div className={styles.home}>
			<ComposeCard
				value={text}
				onChange={setDraftText}
				onCommit={handleCommit}
				connected={connected}
				placeholder={`Send a prompt to ${projectId}…`}
				sending={sending}
				textareaRef={textareaRef}
				images={attachments.images}
				onRemoveImage={attachments.removeImage}
				onFiles={attachments.addFiles}
				onPaste={attachments.handlePaste}
				isDragOver={attachments.isDragOver}
				dragHandlers={attachments.dragHandlers}
				model={model}
				models={models}
				scopedModels={[]}
				thinkingLevel=""
				thinkingLevels={[]}
				onSetModel={handleSetModel}
				onCycleModel={handleCycleModel}
				completion={completion.node}
				beforeKeyDown={completion.handleKeyDown}
			/>
			<div className={styles.hint}>Enter starts a new session · Shift+Enter for a new line</div>
		</div>
	);
});
