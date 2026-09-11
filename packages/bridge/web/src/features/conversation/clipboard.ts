// copyToClipboard — write text to the system clipboard. Returns false on
// failure (e.g. insecure context, permissions) so callers can skip the
// "copied" confirmation rather than misreport success.

export async function copyToClipboard(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}
