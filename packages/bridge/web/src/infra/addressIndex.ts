// ============================================================================
// addressIndex — client-local `(projectId, stem) → sessionId` map.
//
// The ADR 09 cache is keyed by the globally unique `sessionId`, while the URL
// (and the ADR 11 address) only carries `(projectId, stem)`. To derive a cache
// cursor on a cold load we need the session id behind the address, which is
// only known after a first reply. This small localStorage map bridges the two:
// every initial-sync `SessionRef` and every session row (which carries both)
// records its address. A miss simply means "open without a cursor" — a full
// replace, never a correctness problem.
// ============================================================================

const LS_KEY = "pi-bridge:session-addresses";
/** Bounded so a long-lived browser profile cannot grow this without limit. */
const MAX_ENTRIES = 500;

type AddressMap = Record<string, string>;

function key(projectId: string, stem: string): string {
	return `${projectId}\u0000${stem}`;
}

function read(): AddressMap {
	try {
		const raw = localStorage.getItem(LS_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as unknown;
		return parsed !== null && typeof parsed === "object" ? (parsed as AddressMap) : {};
	} catch {
		return {};
	}
}

/** Record an address → session id mapping. Best-effort; never throws. */
export function rememberAddress(projectId: string, stem: string, sessionId: string): void {
	if (!projectId || !stem || !sessionId) return;
	try {
		const map = read();
		map[key(projectId, stem)] = sessionId;
		const keys = Object.keys(map);
		if (keys.length > MAX_ENTRIES) {
			for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete map[k];
		}
		localStorage.setItem(LS_KEY, JSON.stringify(map));
	} catch {
		// localStorage unavailable (private mode): cold loads fall back to a
		// full replace, which is always correct.
	}
}

export function lookupSessionId(projectId: string, stem: string): string | undefined {
	return read()[key(projectId, stem)];
}
