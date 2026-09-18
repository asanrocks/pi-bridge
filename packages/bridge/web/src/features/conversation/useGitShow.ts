// useGitShow — ADR 10 v2 change-card expansion state. Toggling open lazily
// fetches `git show --stat` for the recorded commit once (the result is
// cached for the component's lifetime; re-expansions don't re-fetch).
// Failures (no client, ok:false — e.g. a rebased-away commit — or a throw)
// surface as an error state, not a toast: they're expected.

import { useCallback, useRef, useState } from "react";
import { gitShowRpc } from "../../infra/net/useRpc.ts";

export type GitShowState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "ok"; output: string; truncated: boolean }
	| { status: "error" };

export function useGitShow(commit: string | null) {
	const [expanded, setExpanded] = useState(false);
	const [state, setState] = useState<GitShowState>({ status: "idle" });
	const fetchedFor = useRef<string | null>(null);

	const toggle = useCallback(() => {
		const next = !expanded;
		setExpanded(next);
		// Fetch on first expansion (or when the commit changed).
		if (next && commit !== null && fetchedFor.current !== commit) {
			fetchedFor.current = commit;
			setState({ status: "loading" });
			gitShowRpc(commit).then((result) => {
				setState(result ? { status: "ok", ...result } : { status: "error" });
			});
		}
	}, [commit, expanded]);

	return { expanded, toggle, state };
}
