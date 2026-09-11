// ============================================================================
// prepareImages — browser-side image attachment preparation for the composer.
//
// Mirrors pi's TUI pipeline defaults (image-resize-core.ts: 2000px max side,
// 4.5MB base64 payload, JPEG quality 80) but implemented with canvas APIs —
// pi's stack is Node-only (photon + worker_threads) and fails the
// browser-smoke gate. Oversized images are downscaled via createImageBitmap +
// OffscreenCanvas; undersized whitelisted files pass through untouched (so
// animated GIFs keep their frames).
//
// EXIF orientation: createImageBitmap honors it by default in modern
// browsers, so the re-encode bakes the oriented pixels.
// ============================================================================

import { type ImageContent, MAX_IMAGE_BASE64_LENGTH, MAX_IMAGES_PER_MESSAGE } from "../../../src/core/types.ts";

/** Attachments allowed per message (host-enforced wire limit). */
export const MAX_ATTACHMENTS = MAX_IMAGES_PER_MESSAGE;

/** Whitelisted source mime types. */
const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Max width/height before downscaling (pi parity). */
const MAX_DIMENSION = 2000;

/** JPEG quality for the re-encode of oversized images. */
const JPEG_QUALITY = 0.8;

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

/** Encode canvas pixels as base64 JPEG. */
async function canvasToImageContent(canvas: OffscreenCanvas): Promise<ImageContent> {
	const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
	const data = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
	return { type: "image", data, mimeType: "image/jpeg" };
}

/** Downscale to fit MAX_DIMENSION and re-encode. */
async function resizeToContent(file: File): Promise<ImageContent | null> {
	const bitmap = await createImageBitmap(file);
	try {
		const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
		const w = Math.max(1, Math.round(bitmap.width * scale));
		const h = Math.max(1, Math.round(bitmap.height * scale));
		const canvas = new OffscreenCanvas(w, h);
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		ctx.drawImage(bitmap, 0, 0, w, h);
		return await canvasToImageContent(canvas);
	} finally {
		bitmap.close();
	}
}

export interface PreparedImage {
	image?: ImageContent;
	/** User-facing rejection reason; set when the file was not attached. */
	error?: string;
}

/**
 * Prepare one dropped/pasted/uploaded file for attachment. Returns an error
 * string for rejected files (wrong type, undecodable); never throws.
 */
export async function prepareImageFile(file: File): Promise<PreparedImage> {
	if (!ACCEPTED_TYPES.has(file.type)) {
		return { error: `${file.name || "File"}: unsupported type (${file.type || "unknown"})` };
	}
	// Undersized whitelisted files pass through byte-for-byte (animated GIFs
	// keep their frames); the base64 length check catches the boundary where
	// the 4/3 encoding inflation pushes past the cap — such GIFs are then
	// re-encoded and lose their animation.
	if (file.size < MAX_IMAGE_BASE64_LENGTH) {
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			const data = bytesToBase64(bytes);
			if (data.length <= MAX_IMAGE_BASE64_LENGTH) {
				return { image: { type: "image", data, mimeType: file.type } };
			}
		} catch {
			return { error: `${file.name || "File"}: could not be read` };
		}
	}
	// Oversized (or base64 pushed past the cap): downscale + re-encode.
	try {
		const image = await resizeToContent(file);
		if (!image) return { error: `${file.name || "File"}: could not be processed` };
		return { image };
	} catch {
		return { error: `${file.name || "File"}: could not be processed` };
	}
}

/** Prepare a batch, preserving order; callers surface per-file errors. */
export async function prepareImageFiles(files: Iterable<File>): Promise<{ images: ImageContent[]; errors: string[] }> {
	const images: ImageContent[] = [];
	const errors: string[] = [];
	for (const file of files) {
		const prepared = await prepareImageFile(file);
		if (prepared.image) images.push(prepared.image);
		if (prepared.error) errors.push(prepared.error);
	}
	return { images, errors };
}
