// GitChangeView — ADR 10 v2 boundary git stamp card (prompt / user_bash_end
// anchors): the shared GitChangeRow as a standalone turn between
// user/assistant turns, like UserBashView. Neutral header-line wording
// ("git state observed") — with parallel tools the boundary is positional,
// not causal.

import { memo } from "react";
import type { GitChangeTurn } from "../../../../src/viewmodel/index.ts";
import { GitChangeRow } from "./GitChangeShared.tsx";
import styles from "./turns.module.css";

export const GitChangeView = memo(function GitChangeView({ turn }: { turn: GitChangeTurn }) {
	return (
		<div className={styles.gitChangeTurn}>
			<GitChangeRow change={turn} />
		</div>
	);
});
