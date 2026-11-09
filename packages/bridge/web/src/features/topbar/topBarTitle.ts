// The TopBar center slot's value: the name of the object the surface renders.
// It exists because the published document is `staged` while detached — it
// belongs to the Session being left — so its name cannot be read unconditionally
// without leaking that Session into the Project home.

import type { Document } from "../../../../src/core/index.ts";

/** The store slice the center slot reads. */
export interface TopBarTitleInput {
	currentProjectId: string | null;
	currentStem: string | null;
	document: Document;
}

/** The attached Session's name, else the open Project's id, else "" (the
 * Launcher, where the bar falls back to the app name). */
export function topBarTitle(s: TopBarTitleInput): string {
	return s.currentStem !== null ? s.document.status.name : (s.currentProjectId ?? "");
}
