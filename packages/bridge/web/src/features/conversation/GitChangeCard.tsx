// GitChangeCard — ADR 10 v2 mid-run git change: the shared GitChangeBand
// rendered inside the action group's spine, after the step it follows (e.g.
// after the committing tool's band). Same band anatomy as the tool steps —
// the git family hue (diff/merge green) is the only difference; the group
// legend's git dot uses the same token.

import { memo } from "react";
import type { GitChangeMark } from "../../../../src/viewmodel/index.ts";
import { GitChangeBand } from "./GitChangeShared.tsx";

export const GitChangeCard = memo(function GitChangeCard({ change }: { change: GitChangeMark }) {
	return <GitChangeBand change={change} />;
});
