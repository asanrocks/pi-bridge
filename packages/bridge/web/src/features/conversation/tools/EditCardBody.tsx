// EditCardBody — unified diff card, path as inline annotation (no header bar).
// The diff machinery lives in the shared DiffSections renderer; this body only
// normalizes the edit arguments (normalizeEditArgs — TUI prepareArguments
// parity) so edits-as-JSON-string, single-edit objects, and the legacy
// top-level oldText/newText pair all render the diff the tool executed.

import { memo } from "react";
import styles from "../actions.module.css";
import { type ActionDetailsProps, extToLang, normalizeEditArgs } from "./args.ts";
import { type DiffSectionSpec, DiffSections } from "./DiffSections.tsx";

export const EditCardBody = memo(function EditCardBody({ args }: ActionDetailsProps) {
	const path = args?.path as string | undefined;
	const edits = normalizeEditArgs(args);

	if (path === undefined && (!edits || edits.length === 0)) return null;

	const lang = path ? extToLang(path) : "";
	const sections: DiffSectionSpec[] = (edits ?? [])
		.filter((e) => e.oldText !== "" || e.newText !== "")
		.map((e) => ({ title: null, lang, oldText: e.oldText ?? "", newText: e.newText ?? "" }));

	return <div className={styles.cardBody}>{sections.length > 0 && <DiffSections sections={sections} />}</div>;
});
