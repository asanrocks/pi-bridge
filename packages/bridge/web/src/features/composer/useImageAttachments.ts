// ============================================================================
// useImageAttachments — the composer's attachment behavior, shared by both
// compose surfaces (the session dock and the Project home). Operates on the
// store draft (compose kind): paste/drag-drop/file-input all funnel through
// addFiles, which enforces the wire cap and reports per-file errors as
// toasts. UI-free; the surfaces render chips from `images`.
// ============================================================================

import { useCallback, useRef, useState } from "react";
import type { ImageContent } from "../../../../src/core/index.ts";
import { MAX_ATTACHMENTS, prepareImageFiles } from "../../infra/imageResize.ts";
import { selectDraftImages } from "../../infra/store.ts";
import { useStore } from "../../infra/store.tsx";

export interface ImageAttachmentHandlers {
	onDragEnter: (e: React.DragEvent) => void;
	onDragOver: (e: React.DragEvent) => void;
	onDragLeave: () => void;
	onDrop: (e: React.DragEvent) => void;
}

export function useImageAttachments(): {
	images: ImageContent[];
	addFiles: (files: Iterable<File>) => void;
	removeImage: (index: number) => void;
	handlePaste: (e: React.ClipboardEvent) => void;
	isDragOver: boolean;
	dragHandlers: ImageAttachmentHandlers;
} {
	const images = useStore(selectDraftImages);
	const addDraftImages = useStore((s) => s.addDraftImages);
	const removeDraftImage = useStore((s) => s.removeDraftImage);
	const pushToast = useStore((s) => s.pushToast);

	const [isDragOver, setDragOver] = useState(false);
	// dragenter/dragleave fire per child element; a counter is the standard
	// fix for the flicker (leave fires when moving onto a child).
	const dragDepthRef = useRef(0);

	const addFiles = useCallback(
		(files: Iterable<File>) => {
			const list = [...files].filter((f) => f instanceof File) as File[];
			if (list.length === 0) return;
			void (async () => {
				const room = MAX_ATTACHMENTS - images.length;
				if (room <= 0) {
					pushToast(`attach:${Date.now()}`, `At most ${MAX_ATTACHMENTS} images per message`);
					return;
				}
				const accepted = list.slice(0, room);
				const overflow = list.length - accepted.length;
				const { images: prepared, errors } = await prepareImageFiles(accepted);
				for (const err of errors) pushToast(`attach:${Date.now()}:${err}`, err);
				if (overflow > 0) {
					pushToast(`attach:cap:${Date.now()}`, `At most ${MAX_ATTACHMENTS} images per message`);
				}
				addDraftImages(prepared);
			})();
		},
		[images.length, addDraftImages, pushToast],
	);

	const handlePaste = useCallback(
		(e: React.ClipboardEvent) => {
			const files = e.clipboardData?.files;
			if (files && files.length > 0) {
				e.preventDefault();
				addFiles(files);
			}
		},
		[addFiles],
	);

	const onDragEnter = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		dragDepthRef.current += 1;
		setDragOver(true);
	}, []);

	// dragover fires continuously while hovering; it must NOT touch the
	// enter/leave counter (inflating it strands the drop highlight on).
	const onDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault();
	}, []);

	const onDragLeave = useCallback(() => {
		dragDepthRef.current -= 1;
		if (dragDepthRef.current <= 0) {
			dragDepthRef.current = 0;
			setDragOver(false);
		}
	}, []);

	const onDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			dragDepthRef.current = 0;
			setDragOver(false);
			if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
				addFiles(e.dataTransfer.files);
			}
		},
		[addFiles],
	);

	return {
		images,
		addFiles,
		removeImage: removeDraftImage,
		handlePaste,
		isDragOver,
		dragHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
	};
}
