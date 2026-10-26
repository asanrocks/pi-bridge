// ============================================================================
// SecureContextHint — one-time guidance for a plain-HTTP origin.
//
// The browser withholds the clipboard, notification permission, and service
// workers there. Steps are browser-detected (Firefox pref, Chromium flag,
// otherwise no allowlist) and every string is copyable through the
// dialog-scoped execCommand fallback in `infra/lib/clipboard.ts`, because
// navigator.clipboard is exactly what is missing. Raised lazily and at most
// once per browser session by `infra/lib/secureContext.ts`.
// ============================================================================

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copyWithExecCommandFallback } from "../infra/lib/clipboard.ts";
import { type SecureContextStep, secureContextGuide } from "../infra/lib/secureContext.ts";
import { useStore } from "../infra/state/store.tsx";
import dialogStyles from "../render/Dialog.module.css";
import { Dialog } from "../render/Dialog.tsx";
import { CheckIcon, CopyIcon } from "../render/icons.tsx";
import styles from "./SecureContextHint.module.css";

export const SecureContextHint = memo(function SecureContextHint() {
	const open = useStore((s) => s.secureContextHintOpen);
	const close = useStore((s) => s.closeSecureContextHint);
	if (!open) return null;
	return <SecureContextHintDialog onClose={close} />;
});

function SecureContextHintDialog({ onClose }: { onClose: () => void }) {
	// Location and UA are read once at open: the fix does not change while the
	// dialog is up, and re-reading per render would only churn the text.
	const { guide, origin } = useMemo(
		() => ({ guide: secureContextGuide(window.location, navigator.userAgent), origin: window.location.origin }),
		[],
	);

	return (
		<Dialog label="Secure context required" onClose={onClose}>
			<div className={dialogStyles.title}>Clipboard needs a secure context</div>
			<p className={styles.lead}>
				This page is served over plain HTTP ({origin}), so the browser withholds the clipboard, notification
				permission, and offline support.
			</p>
			{guide.steps.length > 0 ? (
				<section className={styles.section} aria-label={guide.title}>
					<div className={styles.sectionTitle}>{guide.title}</div>
					{guide.steps.map((step) => (
						<Step key={step.location} step={step} />
					))}
				</section>
			) : (
				<p className={styles.note}>
					{guide.title} has no per-origin secure-context allowlist, so there is no setting to change here.
				</p>
			)}
			<p className={styles.note}>
				Or avoid browser settings entirely: open the daemon through an SSH tunnel and use{" "}
				<code>http://localhost</code>, which browsers treat as a secure context.
			</p>
			<div className={dialogStyles.actions}>
				<button type="button" className={dialogStyles.secondary} onClick={onClose}>
					Done
				</button>
			</div>
		</Dialog>
	);
}

function Step({ step }: { step: SecureContextStep }) {
	return (
		<div className={styles.step}>
			<Row label="Open" value={step.location} copyLabel="page" />
			<Row label="Set" value={step.setting} copyLabel="setting" />
			<Row label="to" value={step.value} copyLabel="value" />
			<p className={styles.stepNote}>
				{step.note} Paste the page into a new tab's address bar, then{" "}
				{step.restart ? "restart the browser and reload this page." : "reload this page."}
			</p>
		</div>
	);
}

function Row({ label, value, copyLabel }: { label: string; value: string; copyLabel: string }) {
	return (
		<div className={styles.row}>
			<span className={styles.rowLabel}>{label}</span>
			<code className={styles.rowValue}>{value}</code>
			<CopyButton value={value} label={`Copy ${copyLabel}`} />
		</div>
	);
}

function CopyButton({ value, label }: { value: string; label: string }) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<number | undefined>(undefined);

	useEffect(() => () => window.clearTimeout(timer.current), []);

	const handleCopy = useCallback(async () => {
		if (!(await copyWithExecCommandFallback(value))) return;
		setCopied(true);
		window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => setCopied(false), 1500);
	}, [value]);

	return (
		<button
			type="button"
			className={styles.copyBtn}
			onClick={handleCopy}
			aria-label={copied ? "Copied" : label}
			title={label}
		>
			{copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
		</button>
	);
}
