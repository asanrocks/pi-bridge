// ============================================================================
// ToastBar — persistent notification tray below the top bar.
// Reads from store.notifications; each toast is dismissed by clicking.
// No auto-dismiss timers.
// ============================================================================

import { memo, useCallback } from "react";
import type { Toast } from "../infra/store.ts";
import { getStore, useStore } from "../infra/store.tsx";
import styles from "./ToastBar.module.css";

export const ToastBar = memo(function ToastBar() {
	const notifications = useStore((s) => s.notifications);

	if (notifications.length === 0) return null;

	return (
		<div className={styles.tray}>
			{notifications.map((t) => (
				<ToastItem key={t.id} toast={t} />
			))}
		</div>
	);
});

const ToastItem = memo(function ToastItem({ toast }: { toast: Toast }) {
	const handleDismiss = useCallback(() => {
		getStore().getState().dismissToast(toast.id);
	}, [toast.id]);

	return (
		<button type="button" className={styles.toast} onClick={handleDismiss}>
			<span className={styles.toastText}>{toast.message}</span>
			<span className={styles.toastClose}>✕</span>
		</button>
	);
});
