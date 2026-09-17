// ============================================================================
// useComposeCapabilities — the attachment + path-completion wiring shared by
// both compose surfaces (the session dock and the Project home).
//
// Both surfaces read the SAME store draft (draftPersistence swaps it per
// scope: `s:<sessionId>` for the dock, `p:<projectId>` for the home) and the
// same Project address, so the hook owns the draft value/onChange pair and
// the completion source too — the two containers are now identical (ADR 12:
// listFiles is Project-scoped, so it works pre-send with no attachment).
//
// Returns `cardProps` as a typed Pick of ComposeCardProps: containers spread
// it, so ComposeCard keeps its explicit presentational interface — no opaque
// bundle prop on the card itself.
// ============================================================================

import { useMemo } from "react";
import type { ImageContent } from "../../../../src/core/index.ts";
import { useStore } from "../../infra/store.tsx";
import { listFilesRpc } from "../../infra/useRpc.ts";
import type { ComposeCardProps } from "./ComposeCard.tsx";
import { useImageAttachments } from "./useImageAttachments.ts";
import { type PathCompletionEntry, usePathCompletion } from "./usePathCompletion.tsx";

export type ComposeCapabilityProps = Pick<
	ComposeCardProps,
	"images" | "onRemoveImage" | "onFiles" | "onPaste" | "isDragOver" | "dragHandlers" | "completion" | "beforeKeyDown"
>;

/** No Project address (the global launcher) → no completion source. */
const NO_COMPLETIONS = async (): Promise<PathCompletionEntry[]> => [];

export function useComposeCapabilities(options: { textareaRef: React.RefObject<HTMLTextAreaElement | null> }): {
	cardProps: ComposeCapabilityProps;
	images: ImageContent[];
	closeCompletion: () => void;
} {
	const draft = useStore((s) => s.draft);
	const setDraftText = useStore((s) => s.setDraftText);
	const projectId = useStore((s) => s.currentProjectId);
	const value = draft.kind === "idle" ? "" : draft.text;

	// Stable per Project: usePathCompletion's callbacks depend on `complete`.
	const complete = useMemo(
		() => (projectId === null ? NO_COMPLETIONS : (prefix: string) => listFilesRpc(projectId, prefix)),
		[projectId],
	);

	const attachments = useImageAttachments();
	const completion = usePathCompletion({
		value,
		onChange: setDraftText,
		textareaRef: options.textareaRef,
		complete,
	});

	return {
		images: attachments.images,
		closeCompletion: completion.close,
		cardProps: {
			images: attachments.images,
			onRemoveImage: attachments.removeImage,
			onFiles: attachments.addFiles,
			onPaste: attachments.handlePaste,
			isDragOver: attachments.isDragOver,
			dragHandlers: attachments.dragHandlers,
			completion: completion.node,
			beforeKeyDown: completion.handleKeyDown,
		},
	};
}
