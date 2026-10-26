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

export async function copyToClipboard(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
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
	carrier.remove();
	previous?.focus();
	return copied;
}
