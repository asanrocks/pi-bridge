// ============================================================================
// BuildFooter — the launcher's version line.
//
// Two halves of one deployment can disagree (the daemon restarted with another
// build, an installed app resumed from a cached shell), and that disagreement is
// the first thing to check when the page behaves oddly. Naming both stamps on
// the launcher lets a reader report the pair without opening a console, and
// clicking the line copies them ready to paste.
//
// It states a fact, never a state: the connection control owns "the builds
// disagree". When they do, this line takes the warning hue so the two surfaces
// read as one story, and its text names the app and the daemon separately.
// ============================================================================

import { useState } from "react";
import { type BuildStamp, buildLabel, isReleaseBuild, sameBuild } from "../../../../src/core/index.ts";
import { APP_BUILD } from "../../infra/lib/buildStamp.ts";
import { COPIED_FEEDBACK_MS, copyToClipboard } from "../../infra/lib/clipboard.ts";
import { useStore } from "../../infra/state/store.tsx";
import styles from "./Launcher.module.css";

export interface BuildFooterText {
	/** The line the launcher shows. */
	text: string;
	/** The full triple for both halves — the tooltip, and what a click copies. */
	detail: string;
	/** Both builds are known and are not the same commit. */
	differs: boolean;
}

/** The one wording for the pair. A `null` daemon means its successful aggregate
 * has not arrived on this socket yet, which is stated rather than guessed. */
export function buildFooterText(app: BuildStamp, daemon: BuildStamp | null): BuildFooterText {
	if (daemon === null) {
		return {
			text: `pi-bridge ${buildLabel(app)} · daemon not reported`,
			detail: `${stampTriple("app", app)}\ndaemon: not reported`,
			differs: false,
		};
	}
	// Development is the daemon's call, so a checkout daemon never reads as a
	// disagreement. Otherwise a differing commit is named on both sides: the hue
	// waits for the verdict, the text never hides the pair.
	const differs = isReleaseBuild(daemon) && !sameBuild(app, daemon);
	return {
		text:
			buildLabel(app) === buildLabel(daemon)
				? `pi-bridge ${buildLabel(app)}`
				: `app ${buildLabel(app)} · daemon ${buildLabel(daemon)}`,
		detail: `${stampTriple("app", app)}\n${stampTriple("daemon", daemon)}`,
		differs,
	};
}

function stampTriple(label: string, stamp: BuildStamp): string {
	return `${label}: ${stamp.version}, ${stamp.commit}, ${stamp.date}`;
}

export function BuildFooter() {
	const daemonBuild = useStore((s) => s.daemonBuild);
	const [copied, setCopied] = useState(false);
	const { text, detail, differs } = buildFooterText(APP_BUILD, daemonBuild);

	return (
		<button
			type="button"
			className={`${styles.buildFooter} ${differs ? styles.buildFooterDiffers : ""}`}
			title={`${detail}\nClick to copy`}
			onClick={() => {
				void copyToClipboard(detail).then((ok) => {
					if (!ok) return;
					setCopied(true);
					setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
				});
			}}
		>
			{copied ? "copied" : text}
		</button>
	);
}
