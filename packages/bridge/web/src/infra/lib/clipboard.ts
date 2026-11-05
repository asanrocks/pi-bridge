// copyToClipboard — write text to the system clipboard with the modern async
// API. Returns false on failure so callers can skip the "copied" confirmation
// rather than misreport success, and raises the secure-context guidance when
// the API is missing on a plain-HTTP origin.
//
// Only the secure-context guidance itself may fall back to the legacy
// `execCommand` path (`copyWithExecCommandFallback`): its copy controls must
// work precisely where `navigator.clipboard` does not exist, while every app
// copy action stays on the modern API.

import { noteSecureContextFailure } from "./secureContext.ts";

/** How long a copy confirmation (the Check swap) stays up, in ms — the one
 * value for every copy control including Streamdown's code-block Copy, whose
 * own default this matches. ~2s: long enough to be seen, short enough not to
 * read as a stuck state. */
export const COPIED_FEEDBACK_MS = 2000;

// A copy is confirmed by the Check swap and the `aria-label` change on the
// button, neither of which a screen reader perceives — a label change is not
// announced. The same confirmation therefore runs through a visually hidden
// polite live region, created on first use and styled inline so the mechanism
// needs no class. Cleared after the same window the Check holds, so a second
// copy announces again: a live region announces only changes.
let liveRegion: HTMLElement | null = null;

function announceCopied() {
	if (typeof document === "undefined") return;
	let region = liveRegion;
	if (!region) {
		region = document.createElement("div");
		region.setAttribute("aria-live", "polite");
		region.style.position = "fixed";
		region.style.width = "1px";
		region.style.height = "1px";
		region.style.overflow = "hidden";
		region.style.clipPath = "inset(50%)";
		region.style.whiteSpace = "nowrap";
		document.body.append(region);
		liveRegion = region;
	}
	region.textContent = "Copied to clipboard";
	window.setTimeout(() => {
		if (region.textContent === "Copied to clipboard") region.textContent = "";
	}, COPIED_FEEDBACK_MS);
}

export async function copyToClipboard(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		announceCopied();
		return true;
	} catch {
		// Missing on plain HTTP; also throws on permission denial.
		noteSecureContextFailure();
		return false;
	}
}

/**
 * Clipboard write for the secure-context guidance dialog only. Tries the
 * modern API first, then the legacy hidden-selection carrier, because the
 * origin that needs the guidance is exactly the one without
 * `navigator.clipboard`. The carrier needs the click's user activation, and
 * the inserted textarea is removed with the previous focus restored either
 * way. Do not use this for ordinary app copy actions.
 */
export async function copyWithExecCommandFallback(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		announceCopied();
		return true;
	} catch {
		// Expected on a plain-HTTP origin; try the legacy path.
	}
	return copyWithSelectionCarrier(text);
}

function copyWithSelectionCarrier(text: string): boolean {
	const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	const carrier = document.createElement("textarea");
	carrier.value = text;
	carrier.setAttribute("readonly", "");
	carrier.style.position = "fixed";
	carrier.style.top = "0";
	carrier.style.left = "0";
	carrier.style.opacity = "0";
	document.body.appendChild(carrier);
	carrier.select();
	carrier.setSelectionRange(0, text.length);
	let copied = false;
	try {
		copied = document.execCommand("copy");
	} catch {
		copied = false;
	}
	if (copied) announceCopied();
	carrier.remove();
	previous?.focus();
	return copied;
}
