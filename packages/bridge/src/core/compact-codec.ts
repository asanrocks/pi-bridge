// ============================================================================
// CompactCodec — the transport compaction pair for one WebSocket.
//
// A streamed turn is a run of live patches that differ in exactly one thing:
// the appended string. The envelope — kind, op, path, the attachment
// generation, every other field — is identical from frame to frame, so
// resending it per token spends envelope bytes at the token cadence. The
// codec sends the first frame of a run in full form and every following
// frame that differs from it in exactly the appended value as that value
// alone: a bare JSON string.
//
// The rule is one comparison, not a clearing list: a frame is compacted iff
// it differs from the held template in exactly the appended string value.
// Any other difference — a different path, a different op, a multi-op
// patch, a different attachment generation, a replace, a broadcast, an RPC
// reply — fails the match and travels in full form, and a non-compactable
// frame never touches the template, so an interleave cannot desync the
// pair. Because the template carries every field of the frame (the
// attachment generation included), a frame after an attachment change can
// never match the stale template: compaction across an attachment change
// is structurally unrepresentable, and the decoded frame is the identical
// object the full encoder would have sent — ownership on the wire (ADR 19)
// is preserved, not skipped.
//
// The pair is symmetric: the encoder (the Connection's send path) and the
// decoder (BridgeClient's transport handler) each hold one template,
// replaced only by a full-form compactable frame, and WebSocket message
// ordering keeps the two equal. Compaction requires message-ordered
// delivery; a transport without it must not enable it. The template holds
// the frame by reference — senders construct a fresh frame per send.
// ============================================================================

/** A frame the codec may compact: a patch whose one op is a string append. */
function compactableFrame(frame: Record<string, unknown>): boolean {
	if (frame.kind !== "patch") return false;
	const ops = frame.ops;
	if (!Array.isArray(ops) || ops.length !== 1) return false;
	const op = ops[0];
	if (typeof op !== "object" || op === null) return false;
	const record = op as Record<string, unknown>;
	return record.op === "append" && typeof record.path === "string" && typeof record.value === "string";
}

/** The frame with the appended value removed: the part two frames of one
 * run share. */
function shapeOf(frame: Record<string, unknown>): Record<string, unknown> {
	const op = (frame.ops as Record<string, unknown>[])[0];
	const { value: _value, ...rest } = op;
	return { ...frame, ops: [rest] };
}

/** Structural equality with undefined-valued keys ignored. Key order is not
 * significant: frames built by different code paths may order their fields
 * differently. */
function shapeEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	const ar = a as Record<string, unknown>;
	const br = b as Record<string, unknown>;
	const aKeys = Object.keys(ar).filter((k) => ar[k] !== undefined);
	const bKeys = Object.keys(br).filter((k) => br[k] !== undefined);
	if (aKeys.length !== bKeys.length) return false;
	for (const key of aKeys) {
		if (!Object.hasOwn(br, key)) return false;
		if (!shapeEqual(ar[key], br[key])) return false;
	}
	return true;
}

export class CompactCodec {
	/** The last full-form compactable frame this side sent or received. */
	private template: Record<string, unknown> | null = null;

	/** Encode one outgoing frame: the full JSON envelope, or — when the frame
	 * differs from the held template in exactly the appended value — that
	 * value alone as a bare JSON string. */
	encode(frame: Record<string, unknown>): string {
		if (compactableFrame(frame) && this.template !== null && shapeEqual(shapeOf(frame), shapeOf(this.template))) {
			const op = (frame.ops as Record<string, unknown>[])[0];
			return JSON.stringify(op.value);
		}
		if (compactableFrame(frame)) this.template = frame;
		return JSON.stringify(frame);
	}

	/** Hold one parsed full-form incoming frame as the decode template when
	 * it is compactable. Any other frame never touches the template: an RPC
	 * reply, a broadcast, or a multi-op patch interleaved into a run cannot
	 * desync the pair. */
	observe(parsed: Record<string, unknown>): void {
		if (!compactableFrame(parsed)) return;
		this.template = parsed;
	}

	/** Decode one bare JSON string into the frame the encoder would have
	 * sent in full form. Null when no template is held — a protocol
	 * violation (the peer compacted with no run established). */
	decode(value: string): Record<string, unknown> | null {
		if (this.template === null) return null;
		const op = (this.template.ops as Record<string, unknown>[])[0];
		return { ...this.template, ops: [{ ...op, value }] };
	}
}
