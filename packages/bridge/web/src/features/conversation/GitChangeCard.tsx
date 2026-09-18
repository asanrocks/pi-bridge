// GitChangeCard — ADR 10 v2 mid-turn git change: the shared GitChangeRow
// rendered inside the action group's vertical line, after the action it follows (e.g.
// after the committing tool's tinted row). Same tinted row anatomy as the tool actions —
// the git hue (diff/merge green) is the only difference; the group
// legend's git dot uses the same token.

import { memo } from "react";
import type { InlineGitStamp } from "../../../../src/viewmodel/index.ts";
import { GitChangeRow } from "./GitChangeShared.tsx";

export const GitChangeCard = memo(function GitChangeCard({ change }: { change: InlineGitStamp }) {
	return <GitChangeRow change={change} />;
});
