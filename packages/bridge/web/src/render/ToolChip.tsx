// ============================================================================
// ToolChip — the running tool and its phase clock as one value chip:
// `bash · 5s`. A mark, not a control: it states what is executing and is never
// pressed, so it takes a hairline boundary instead of the fill that carries a
// control's state. One spec for both hosts (the sidebar rail and the Launcher
// queue), because the same tool is not two objects.
// ============================================================================

import styles from "./ToolChip.module.css";

export function ToolChip({ tool }: { tool: { name: string; elapsed?: string } }) {
	return (
		<span className={styles.toolChip}>
			<span className={styles.toolName}>{tool.name}</span>
			{tool.elapsed !== undefined && (
				<>
					<span className={styles.toolDot} aria-hidden="true">
						·
					</span>
					<span className={styles.toolElapsed}>{tool.elapsed}</span>
				</>
			)}
		</span>
	);
}
