// ============================================================================
// useComposeCapabilities — the attachment + path-completion wiring shared by
// both compose surfaces (the session dock and the Project home).
//
// Both surfaces read the SAME store draft (draftPersistence swaps it per
// scope: `s:<sessionId>` for the dock, `p:<projectId>` for the home), so the
// hook owns the value/onChange pair too. The only input that differs is the
// completion source: the dock resolves paths against the attached session's
// Project cwd, while the home has no attachment yet (the `listFiles`
// re-address to the Project is deferred — ADR 12).
//
// Returns `cardProps` as a typed Pick of ComposeCardProps: containers spread
// it, so ComposeCard keeps its explicit presentational interface — no opaque
// bundle prop on the card itself.
// ============================================================================

import type { ImageContent } from "../../../../src/core/index.ts";
import { useStore } from "../../infra/store.tsx";
import type { ComposeCardProps } from "./ComposeCard.tsx";
import { useImageAttachments } from "./useImageAttachments.ts";
import { type PathCompletionEntry, usePathCompletion } from "./usePathCompletion.tsx";

export type ComposeCapabilityProps = Pick<
	ComposeCardProps,
	"images" | "onRemoveImage" | "onFiles" | "onPaste" | "isDragOver" | "dragHandlers" | "completion" | "beforeKeyDown"
>;

export function useComposeCapabilities(options: {
	textareaRef: React.RefObject<HTMLTextAreaElement | null>;
	complete: (prefix: string) => Promise<PathCompletionEntry[]>;
}): {
	cardProps: ComposeCapabilityProps;
	images: ImageContent[];
	closeCompletion: () => void;
} {
	const draft = useStore((s) => s.draft);
	const setDraftText = useStore((s) => s.setDraftText);
	const value = draft.kind === "idle" ? "" : draft.text;

	const attachments = useImageAttachments();
	const completion = usePathCompletion({
		value,
		onChange: setDraftText,
		textareaRef: options.textareaRef,
		complete: options.complete,
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
