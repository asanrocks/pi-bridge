// ============================================================================
// dictationToolbarPreference — whether the dictation toolbar is showing is a
// device preference, not session state.
//
// Same reasoning as the display scale: the disclosure is about how this person
// works, not about the draft in front of them, so the flag survives a reload, a
// Session switch, and the other composer surface (the dock and the Project home
// share one key). Closed is the default — a microphone nobody pressed must not
// take screen space — and the pressed state is stored as readable words so a
// stale value degrades to closed rather than to something surprising.
//
// Storage is optional: private mode and disabled storage only cost the flag its
// persistence, never its meaning for this page life.
// ============================================================================

const LS_KEY = "pi-bridge:dictation-toolbar";

/** The stored flag, or closed when there is none or it cannot be read. */
export function loadDictationToolbarOpen(): boolean {
	if (typeof localStorage === "undefined") return false;
	try {
		return localStorage.getItem(LS_KEY) === "open";
	} catch {
		return false;
	}
}

export function saveDictationToolbarOpen(open: boolean): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(LS_KEY, open ? "open" : "closed");
	} catch {
		// Storage unavailable (private mode): the flag still applies for this page.
	}
}
