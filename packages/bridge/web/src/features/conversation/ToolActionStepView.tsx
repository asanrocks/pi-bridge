// ToolActionStepView — one tool action rendered as a tinted band (hue = kind)
// wrapping a triangle-at-start fold and, when expanded, the card: a single
// bordered surface on the normal background, split by a hairline divider —
// above it the chrome (status line with hover controls, identity line, error
// strip), below it the capped content region. All kinds share the identical
// card; the band's tint is the only kind-specific surface. When the content
// is capped, a persistent bottom fade signals the clipping (data must never
// disappear silently); the clickable "show all" lives in the hover controls.

import { memo, useCallback, useMemo } from "react";
import {
	beautifyShellCommand,
	kindForTool,
	makeActionIdentity,
	makeActionSummary,
	type ShellCommandSegment,
	stepWants,
	type ToolActionStepVM,
} from "../../../../src/viewmodel/index.ts";
import { useStore } from "../../infra/store.tsx";
import { wantPull } from "../../infra/wants.ts";
import styles from "./conversation.module.css";
import { ActionDetails } from "./tools/ActionDetails.tsx";
import { normalizeEditArgs, type ToolArgs, useCwd, useLiveArgs, useResultText } from "./tools/args.ts";
import { BandPreview } from "./tools/BandPreview.tsx";
import { BashIdentity } from "./tools/BashIdentity.tsx";
import { CardControls, CardError, CardIdentity, CardStatusLine } from "./tools/CardSkeleton.tsx";
import {
	BASH_TAIL_LINES,
	bashStatusChip,
	parseBashResult,
	parseReadNotice,
	type StatusChip,
} from "./tools/resultText.ts";
import { useToolTiming } from "./tools/timing.ts";
import { useDetailsCap } from "./tools/useDetailsCap.ts";

/** Shell-family tools sharing the bash card (same executor, same result
 * text format — status suffixes, truncation footers). */
const SHELL_TOOLS = new Set(["bash", "powershell"]);

/** Bodies whose content is text and gains from the wrap toggle. */
const WRAP_TOOLS = new Set(["read", "write", "bash", "powershell", "grep", "find", "ls"]);

/** Registry-known tool names (anything else renders via the fallback body). */
const KNOWN_TOOLS = new Set(["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"]);

const ToolActionStepView = memo(function ToolActionStepView({
	step,
	onToggleStep,
}: {
	step: ToolActionStepVM;
	onToggleStep: (key: string) => void;
}) {
	const actionKey = `${step.entryId}:b${step.blockIndex}`;
	const isExpanded = useStore(useCallback((s) => s.expandedSteps.has(actionKey), [actionKey]));
	const cardWrap = useStore((s) => s.cardWrap);
	const cardMarkdown = useStore((s) => s.cardMarkdown);
	const toggleCardWrap = useStore((s) => s.toggleCardWrap);
	const toggleCardMarkdown = useStore((s) => s.toggleCardMarkdown);
	const cwd = useCwd();
	const handleToggle = useCallback(() => onToggleStep(actionKey), [onToggleStep, actionKey]);
	const kind = kindForTool(step.toolName);

	// Live arguments from the store so the summary and the identity line
	// update as the tool call arguments stream in (the VM cache key excludes
	// argument values). ADR 09: the group header only pulls edit/write
	// arguments, so this step registers its own want whenever it renders
	// (collapsed rows need the summary too); ActionDetails adds the result
	// wants when expanded. The pullTick subscription re-registers wants
	// after pull failures and refreshes after ingests.
	useStore((s) => s.pullTick);
	wantPull(stepWants(step, false));
	const args = useLiveArgs(step);
	const liveSummary = makeActionSummary(step.toolName, args, cwd);
	const identity = makeActionIdentity(step.toolName, args, cwd);
	const recArgs = args && typeof args === "object" && !Array.isArray(args) ? (args as ToolArgs) : null;
	const isShell = SHELL_TOOLS.has(step.toolName);
	const liveCmd = isShell && typeof recArgs?.command === "string" ? (recArgs.command as string) : null;
	const timeout = isShell && typeof recArgs?.timeout === "number" ? (recArgs.timeout as number) : null;
	const timing = useToolTiming(step.toolCallId, step.status);

	// Result text — sanitized (ANSI/binary/\r) and trimmed; feeds the error
	// strip, the bash chips/copy parsing, and the copy payload.
	const resultText = useResultText(step);

	// Error text for the skeleton strip. Bash is excluded: its error results
	// are genuine command output plus a status line appended by the tool —
	// the output stays in the content area, the status line becomes a chip.
	const errorText = step.result?.isError && !isShell ? resultText : null;

	// Bash result parsing — status line → top-bar chip, truncation footer →
	// notice strip (rendered by the body), output → content/copy payload.
	const bashParsed = isShell && resultText !== null ? parseBashResult(resultText) : null;
	const chips: ReadonlyArray<StatusChip> =
		bashParsed?.status !== null && bashParsed?.status !== undefined ? [bashStatusChip(bashParsed.status)] : [];

	// Copy payload — the primary artifact of the call: the file content
	// (read, continuation notice stripped), the written content (write), the
	// replacement text union (edit), the command output (bash, status line
	// and truncation footer stripped).
	const copyText = useMemo(() => {
		switch (step.toolName) {
			case "write":
				return typeof recArgs?.content === "string" ? (recArgs.content as string) : null;
			case "edit": {
				const edits = normalizeEditArgs(recArgs);
				return edits ? edits.map((e) => e.newText).join("\n") : null;
			}
			case "read":
				if (step.result?.isError) return null;
				return resultText !== null ? parseReadNotice(resultText).content || null : null;
			case "bash":
			case "powershell":
				return bashParsed !== null ? bashParsed.output || null : null;
			default:
				return resultText;
		}
	}, [recArgs, resultText, bashParsed, step.result, step.toolName]);

	// Content-view controls. Wrap applies to text-content bodies (the diff
	// body wraps inherently); markdown applies to .md file content only.
	const showWrap = WRAP_TOOLS.has(step.toolName) || !KNOWN_TOOLS.has(step.toolName);
	const mdPath =
		(step.toolName === "read" || step.toolName === "write") && typeof recArgs?.path === "string"
			? (recArgs.path as string)
			: null;
	const showMarkdown = mdPath?.endsWith(".md") ?? false;

	// Height-cap + clipped-fade mechanics for the details panel (shared with
	// UserBashView — see useDetailsCap). Shell cards opt out: their cap is
	// line-count-based (the tail slice in BashCardBody), not the scroll
	// window — no clipped-fade detection applies.
	const {
		isUncapped,
		toggleUncap,
		atTail,
		capped: panelCapped,
		cardRef,
	} = useDetailsCap(actionKey, isExpanded && !isShell);
	const handleUncap = useCallback(() => toggleUncap(actionKey), [toggleUncap, actionKey]);
	// Shell cap: the output tail-slice bound (BashCardBody), not panel
	// clipping — drives the top-bar "show all" control.
	const capped = isShell
		? isUncapped
			? "uncapped"
			: bashParsed && bashParsed.output.split("\n").length > BASH_TAIL_LINES
				? "capped"
				: "none"
		: panelCapped;

	return (
		<div className={styles.actionStep} data-kind={kind}>
			<div className={styles.stepHead}>
				<button
					type="button"
					className={styles.stepFold}
					onClick={handleToggle}
					aria-expanded={isExpanded}
					aria-label={`${isExpanded ? "Collapse" : "Expand"} ${liveSummary}`}
				>
					<span className={styles.foldTri}>{isExpanded ? "\u25BE" : "\u25B8"}</span>
					<span className={styles.stepSummary}>
						{/* Collapsed shell steps render the beautified command (folded
						  tokens as chips); the raw string stays the aria label, and the
						  expanded card's identity line shows the command unmodified. */}
						{isShell && liveCmd !== null ? <ShellSummary command={liveCmd} cwd={cwd} /> : liveSummary}
					</span>
				</button>
			</div>
			{!isExpanded && <BandPreview step={step} />}
			{isExpanded && (
				<div className={styles.detailsCard}>
					<div className={styles.cardBar}>
						<CardStatusLine status={step.status} timing={timing} timeout={timeout} chips={chips} />
						<CardControls
							copyText={copyText}
							showWrap={showWrap}
							wrap={cardWrap}
							showMarkdown={showMarkdown}
							markdown={cardMarkdown}
							capped={capped}
							onToggleWrap={toggleCardWrap}
							onToggleMarkdown={toggleCardMarkdown}
							onToggleCap={handleUncap}
						/>
					</div>
					{/* Shell cards highlight the command (bash/powershell grammar);
					    every other kind keeps the plain identity line. */}
					{isShell && identity !== null ? (
						<BashIdentity command={identity} lang={step.toolName} />
					) : (
						<CardIdentity text={identity} />
					)}
					<CardError text={errorText} />
					<div className={styles.stepDetailsWrap}>
						<div
							className={styles.stepDetails}
							style={isUncapped || isShell ? { maxHeight: "none" } : undefined}
							ref={cardRef}
						>
							<ActionDetails step={step} />
						</div>
						{!isShell && capped === "capped" && !atTail && (
							<div className={styles.stepDetailsFade} aria-hidden="true" />
						)}
					</div>
				</div>
			)}
		</div>
	);
});

/** Beautified shell command for the collapsed fold row — command words
 * ("npm run") as tinted chips, folded tokens (leading "cd dir &&", deep
 * absolute paths) as dimmed-italic abbreviations whose title tooltip carries
 * the original. A command nothing applies to renders as the plain string. */
function ShellSummary({ command, cwd }: { command: string; cwd: string | null }) {
	const segments = useMemo(() => beautifyShellCommand(command, cwd), [command, cwd]);
	if (segments.length === 1 && segments[0].kind === "text") return segments[0].text;
	return (
		<>
			{segments.map((s: ShellCommandSegment, i: number) =>
				s.kind === "fold" ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: segment order is the identity; originals may repeat
					<span key={i} className={styles.foldAbbrev} title={s.original}>
						{s.label}
					</span>
				) : s.kind === "cmd" ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: segment order is the identity
					<span key={i} className={styles.cmdChip}>
						{s.text}
					</span>
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: segment order is the identity
					<span key={i}>{s.text}</span>
				),
			)}
		</>
	);
}

export { ToolActionStepView };
