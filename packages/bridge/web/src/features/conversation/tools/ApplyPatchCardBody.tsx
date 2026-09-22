// ApplyPatchCardBody — Codex-style apply_patch envelope (pi-apply-patch
// extension) rendered as per-file diff sections: Add (all-added), Update
// (per-chunk diff with `@@` seek markers as muted notes, `Move to` folded
// into the title), Delete (label only — the old content is not in the
// envelope). The envelope is self-contained, so no disk read is involved.
//
// Streaming-tolerant: parseApplyPatch returns whatever sections have arrived;
// before the envelope starts (or when the input is malformed) the raw text
// renders as a code block so content never disappears silently. The tool's
// result text renders under the diff — failures cross the wire as normal
// (non-error) content, so the body owns their visibility.

import { memo } from "react";
import { applyPatchInput, displayPath, parseApplyPatch } from "../../../../../src/viewmodel/index.ts";
import { useStore } from "../../../infra/state/store.tsx";
import { CodeSnippet } from "../../../render/CodeSnippet.tsx";
import styles from "../actions.module.css";
import { type ActionDetailsProps, extToLang, useCwd } from "./args.ts";
import { type DiffSectionSpec, DiffSections } from "./DiffSections.tsx";

export const ApplyPatchCardBody = memo(function ApplyPatchCardBody({ args, resultText }: ActionDetailsProps) {
	const openFileViewer = useStore((s) => s.openFileViewer);
	const cwd = useCwd();
	const input = applyPatchInput(args);
	if (input === null) return null;
	const rel = (p: string) => displayPath(p, cwd);

	const parsed = parseApplyPatch(input);
	if (!parsed.ok) {
		// Not an envelope yet (or malformed) — raw text keeps streaming
		// content visible; the tool result reports hard failures.
		if (input.trim().length === 0) return null;
		return (
			<div className={styles.cardBody}>
				<CodeSnippet code={input} />
			</div>
		);
	}

	const sections: DiffSectionSpec[] = [];
	for (const section of parsed.sections) {
		switch (section.type) {
			case "add":
				sections.push({
					title: `Add ${rel(section.filePath)}`,
					viewPath: section.filePath,
					lang: extToLang(section.filePath),
					oldText: "",
					newText: section.content,
				});
				break;
			case "delete":
				// Old content is not in the envelope — the operation label is
				// the honest rendering; on-disk state is the viewer's job.
				sections.push({
					title: `Delete ${rel(section.filePath)}`,
					viewPath: section.filePath,
					lang: "",
					oldText: "",
					newText: "",
				});
				break;
			case "update": {
				const title =
					section.movePath !== null
						? `Update ${rel(section.filePath)} → ${rel(section.movePath)}`
						: `Update ${rel(section.filePath)}`;
				const lang = extToLang(section.movePath ?? section.filePath);
				// A move's content lives at the target afterwards — the viewer
				// shows current disk state, so it opens the move target.
				const viewPath = section.movePath ?? section.filePath;
				if (section.chunks.length === 0) {
					// Header streamed, hunks not yet.
					sections.push({ title, viewPath, lang, oldText: "", newText: "" });
					break;
				}
				for (let i = 0; i < section.chunks.length; i++) {
					const chunk = section.chunks[i];
					sections.push({
						title: i === 0 ? title : null,
						viewPath: i === 0 ? viewPath : null,
						notes: chunk.contexts.length > 0 ? chunk.contexts : undefined,
						lang,
						oldText: chunk.oldText,
						newText: chunk.newText,
					});
				}
				break;
			}
		}
	}

	return (
		<div className={styles.cardBody}>
			{sections.length > 0 && <DiffSections sections={sections} onOpenView={openFileViewer} />}
			{resultText && <div className={styles.cardConfirm}>{resultText}</div>}
		</div>
	);
});
