// ============================================================================
// useComposerCommit — the draft→wire commit flow for the session dock.
//
// Two paths, both atomic on the draft (clear only after the RPC resolves ok;
// restore on failure so nothing is lost):
//  - compose: prompt() — available while streaming (queues a steer); only
//    compaction blocks it.
//  - edit: fork the edited message — navigate() to its parent, then prompt()
//    with the edited text (plus the entry's images — the edit UI only covers
//    text). The AgentSession forks at the parent, producing a sibling user
//    turn. Blocked while streaming/compacting (a fork mid-turn would race
//    the run).
//
// The optimistic clear empties the textarea immediately — the prompt RPC
// awaits the *whole turn* (Manager.prompt awaits session.prompt), so clearing
// only on resolve would leave the text through the entire stream. The restore
// preserves the no-data-loss guarantee: a failed or offline send keeps the
// text for retry.
// ============================================================================

import { useCallback } from "react";
import type { ImageContent } from "../../../../src/core/index.ts";
import { requestNotificationPermission } from "../../infra/lib/notificationPermission.ts";
import { getStore } from "../../infra/state/store.tsx";
import { selectRenderDiverged } from "../../infra/state/ui.ts";

export interface RpcForCommit {
	navigate: (entryId: string | null) => Promise<unknown>;
	prompt: (text: string, images?: ImageContent[]) => Promise<unknown>;
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
			const promptReply = await rpc.prompt(text, entryImages);
			if (!isOk(promptReply)) {
				// Leaf moved to the parent (the intended fork point); restore as
				// a compose draft so retrying forks at the same place.
				getStore().getState().setDraft({ kind: "compose", text });
				return;
			}
		} else {
			// Compose: streaming is OK (queues a steer); only compaction blocks.
			if (s.document.status.isCompacting) return;
			requestNotificationPermission();
			const savedDraft = draft;
			getStore().getState().clearDraft();
			const reply = await rpc.prompt(text, draftImages);
			if (!isOk(reply)) {
				getStore().getState().setDraft(savedDraft);
			}
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
