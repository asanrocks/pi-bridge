// ============================================================================
// useComposerCommit — the draft→wire commit flow for the session dock.
//
// Two paths, both atomic on the draft (cleared optimistically before the RPC
// leaves, and restored only on a *definitive* refusal so nothing is lost):
//  - compose: prompt() — available while streaming (queues a steer); only
//    compaction blocks it.
//  - edit: fork the edited message — navigate() to its parent, then prompt()
//    with the edited text (plus the entry's images — the edit UI only covers
//    text). The AgentSession forks at the parent, producing a sibling user
//    turn. Blocked while streaming/compacting (a fork mid-turn would race
//    the run).
//
// Both paths carry the send's model selection (the stateless client API,
// computed by nextSelectionOf — the local pick else path inheritance); the
// successful send consumes the pick, so the next send inherits from the path
// the turn just recorded instead of a stale pick. A send admitted while the
// turn is in flight is a steer: it carries nothing and keeps the pick.
//
// The optimistic clear is what makes a send feel instant. Its counterpart is
// the failure taxonomy: the prompt reply is an *admission* acknowledgement
// (ADR 12 Reply semantics), so `ok: false` means nothing was admitted and the
// text goes back to the composer, while a reply-less rejection (the transport
// died) means the outcome is unknown — the turn may be running, so restoring
// the draft there would invite a duplicate send. The send anchor plus the
// reattached document decide that case.
// ============================================================================

import { useCallback } from "react";
import type { ImageContent, ModelRef } from "../../../../src/core/index.ts";
import { requestNotificationPermission } from "../../infra/lib/notificationPermission.ts";
import { getStore } from "../../infra/state/store.tsx";
import { selectRenderDiverged } from "../../infra/state/ui.ts";
import { nextSelectionOf } from "./nextSelection.ts";
import { sendOutcomeOf } from "./sendOutcome.ts";

export interface RpcForCommit {
	navigate: (entryId: string | null) => Promise<unknown>;
	prompt: (text: string, images?: ImageContent[], model?: ModelRef, thinkingLevel?: string) => Promise<unknown>;
}

/** A reply is ok when it exists and its `ok` field is true (RpcReply-shaped). */
function isOk(reply: unknown): boolean {
	return typeof reply === "object" && reply !== null && (reply as { ok?: unknown }).ok === true;
}

export function useComposerCommit(rpc: RpcForCommit) {
	/** Send the current draft (compose or edit). Invoked by the dock's Send. */
	const commit = useCallback(async () => {
		const s = getStore().getState();
		const draft = s.draft;
		if (draft.kind === "idle") return;
		const text = draft.text;
		const draftImages = draft.kind === "compose" ? draft.images : undefined;
		// Image-only sends are allowed: empty text with attachments.
		if (!text.trim() && !(draftImages && draftImages.length > 0)) return;
		// Connection pre-flight: a disconnected send is a no-op RPC; keep
		// the draft and surface why instead of silently dropping it.
		if (s.connection.kind !== "connected" || !s.currentStem) {
			s.pushToast("draft:offline", "Not connected; draft kept");
			return;
		}
		// Peek lock (ground truth): while the rendering leaf is pinned away
		// from the live leaf, every mutation is blocked — a send would steer
		// (or fork onto) a branch the user is not looking at. The draft is
		// kept; the jump button's "back to live" re-arms sending.
		if (selectRenderDiverged(s)) {
			s.pushToast("draft:peek", "Viewing another branch — back to live to send");
			return;
		}
		// The send's model selection, computed before any RPC leaves: the
		// draft's fork point (edit) or the live leaf (compose) is what the
		// send continues, and the navigate below moves the leaf before the
		// prompt fires.
		const selection = nextSelectionOf({
			document: s.document,
			draft,
			pick: s.selectionPick,
			models: s.models,
		});
		if (draft.kind === "edit") {
			if (s.document.status.isStreaming || s.document.status.isCompacting) return;
			const entry = s.document.entries[draft.entryId];
			if (!entry) return;
			// The fork re-sends the edited message; carry its images so the fork
			// doesn't silently drop attachments (edit UI only covers text).
			const entryImages =
				entry.kind === "message" ? entry.content.filter((c): c is ImageContent => c.type === "image") : undefined;
			const savedDraft = draft;
			getStore().getState().clearDraft();
			const navReply = await rpc.navigate(entry.parentId);
			if (!isOk(navReply)) {
				getStore().getState().setDraft(savedDraft); // navigate failed; edit intact
				return;
			}
			// Arm after the fork-point navigate has landed (patches precede the
			// reply on the wire, so the store is already post-navigate here) —
			// the store-side baseline then reflects the pre-fork path, and the
			// flag consumes on the forked message, not on the navigate's own
			// path change.
			getStore().getState().armSendAnchor();
			const promptReply = await rpc.prompt(text, entryImages, selection.carryModel, selection.carryLevel);
			const outcome = sendOutcomeOf(promptReply);
			if (outcome === "refused") {
				getStore().getState().clearSendAnchor();
				// Leaf moved to the parent (the intended fork point); restore as
				// a compose draft so retrying forks at the same place.
				getStore().getState().setDraft({ kind: "compose", text });
				return;
			}
			// Unknown outcome (no reply): the fork may have landed. Keep the
			// anchor and the cleared draft; the reattached document decides.
			if (outcome === "unknown") return;
		} else {
			// Compose: streaming is OK (queues a steer); only compaction blocks.
			if (s.document.status.isCompacting) return;
			requestNotificationPermission();
			const savedDraft = draft;
			getStore().getState().clearDraft();
			// Arm before the RPC leaves: the flag is set synchronously, so the
			// appended user entry can never render before the viewport sees it.
			getStore().getState().armSendAnchor();
			const reply = await rpc.prompt(text, draftImages, selection.carryModel, selection.carryLevel);
			const outcome = sendOutcomeOf(reply);
			if (outcome === "refused") {
				getStore().getState().clearSendAnchor();
				getStore().getState().setDraft(savedDraft);
				return;
			}
			// Unknown outcome (no reply): the turn may be running. Keep the
			// anchor and the cleared draft — restoring the text here would
			// duplicate a send the daemon already admitted.
			if (outcome === "unknown") return;
		}
		// The turn that carried the selection recorded it on its path — the
		// next send inherits from the path, so the pick is consumed. A send
		// admitted mid-turn carried nothing (nextSelectionOf gates on the same
		// busy state, as the worker does), so its pick stays and lands on the
		// next idle send instead of being spent on a steer that could not use
		// it.
		if (!s.document.status.isStreaming && !s.document.status.isCompacting) {
			getStore().getState().clearSelectionPick();
		}
	}, [rpc]);

	/** Enter edit mode for a past user message (pre-fills the textarea). */
	const beginEdit = useCallback((entryId: string, index: number, text: string) => {
		const s = getStore().getState();
		if (s.document.status.isStreaming || s.document.status.isCompacting) return;
		if (selectRenderDiverged(s)) return; // peek is browse-only
		if (s.draft.kind === "edit") return; // already editing
		s.beginEdit(entryId, index, text);
	}, []);

	return { commit, beginEdit };
}
