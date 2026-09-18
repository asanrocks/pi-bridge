// ============================================================================
// Copy / Check icons — shared affordance for "copy" actions.
//
// Replicates streamdown's bundled CopyIcon/CheckIcon exactly (16x16 viewBox,
// evenodd fill, currentColor) so the turn-text Copy button and the code-block
// Copy button (rendered by streamdown) read as one icon set. This is the
// "copy affordance" role from ADR 07 §Styling invariants #3: one icon across
// containers, different container chrome per hue.
// ============================================================================

interface IconProps {
	size?: number;
	className?: string;
}

export function CopyIcon({ size = 16, className }: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			color="currentColor"
			strokeLinejoin="round"
			className={className}
			aria-hidden="true"
		>
			<path
				clipRule="evenodd"
				fill="currentColor"
				fillRule="evenodd"
				d="M2.75 0.5C1.7835 0.5 1 1.2835 1 2.25V9.75C1 10.7165 1.7835 11.5 2.75 11.5H3.75H4.5V10H3.75H2.75C2.61193 10 2.5 9.88807 2.5 9.75V2.25C2.5 2.11193 2.61193 2 2.75 2H8.25C8.38807 2 8.5 2.11193 8.5 2.25V3H10V2.25C10 1.2835 9.2165 0.5 8.25 0.5H2.75ZM7.75 4.5C6.7835 4.5 6 5.2835 6 6.25V13.75C6 14.7165 6.7835 15.5 7.75 15.5H13.25C14.2165 15.5 15 14.7165 15 13.75V6.25C15 5.2835 14.2165 4.5 13.25 4.5H7.75ZM7.5 6.25C7.5 6.11193 7.61193 6 7.75 6H13.25C13.3881 6 13.5 6.11193 13.5 6.25V13.75C13.5 13.8881 13.3881 14 13.25 14H7.75C7.61193 14 7.5 13.8881 7.5 13.75V6.25Z"
			/>
		</svg>
	);
}

export function ChevronDownIcon({ size = 16, className }: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			aria-hidden="true"
		>
			<path d="M3.5 6L8 10.5L12.5 6" />
		</svg>
	);
}

export function CheckIcon({ size = 16, className }: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			color="currentColor"
			strokeLinejoin="round"
			className={className}
			aria-hidden="true"
		>
			<path
				clipRule="evenodd"
				fill="currentColor"
				fillRule="evenodd"
				d="M15.5607 3.99999L15.0303 4.53032L6.23744 13.3232C5.55403 14.0066 4.44599 14.0066 3.76257 13.3232L4.2929 12.7929L3.76257 13.3232L0.969676 10.5303L0.439346 9.99999L1.50001 8.93933L2.03034 9.46966L4.82323 12.2626C4.92086 12.3602 5.07915 12.3602 5.17678 12.2626L13.9697 3.46966L14.5 2.93933L15.5607 3.99999Z"
			/>
		</svg>
	);
}
