// ============================================================================
// DraftOwnership — which draft a dictation may write into.
//
// The editor is whatever textarea is mounted right now, so an element that
// survives a Session switch is silently a different document: the store draft
// was replaced, and the offsets the editing model owns no longer describe the
// utterance's span. One utterance therefore belongs to the draft it started in;
// once the composer moves on, that ownership is gone for good — switching back
// does not restore it — and every later read and write is refused, so a
// dictation can never type into a document it never saw.
//
// This is the composer's guard, not the ASR package's: the package guarantees
// that a cancellation ends the utterance (no pending settlement writes after
// it), and this says *which* document the utterance was cancelled for.
// ============================================================================

export class DraftOwnership {
	private current: string;
	private owned: string | null = null;

	constructor(scope: string) {
		this.current = scope;
	}

	/** The draft the composer shows now. A change ends the owned utterance.
	 * Returns true when the draft actually changed. */
	setCurrent(scope: string): boolean {
		if (scope === this.current) return false;
		this.current = scope;
		this.owned = null;
		return true;
	}

	/** Claim the current draft for the utterance starting now. */
	claim(): void {
		this.owned = this.current;
	}

	/** True while this utterance's draft is still the one on screen. */
	get writable(): boolean {
		return this.owned !== null && this.owned === this.current;
	}
}
