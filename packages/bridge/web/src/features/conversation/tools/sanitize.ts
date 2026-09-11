// Output sanitization — mirrors the TUI's render-utils getTextOutput
// pipeline (stripAnsi → sanitizeBinaryOutput → drop \r) so tool results
// render the same in both surfaces: ANSI escapes from commands that
// colorize, control characters from binary output, and stray carriage
// returns never reach the card content. Copy payloads share the treatment
// (escape sequences would not paste usefully).
//
// ANSI strip from ansi-regex (MIT); the binary filter is a port of the
// coding-agent's shell.ts sanitizeBinaryOutput — kept in sync with it.

const ANSI_PATTERN =
	"(?:\\u001B\\][\\s\\S]*?(?:\\u0007|\\u001B\\u005C|\\u009C))" + // OSC sequences
	"|[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]"; // CSI and related

const ANSI_RE = new RegExp(ANSI_PATTERN, "g");

function stripAnsi(value: string): string {
	// Fast path: ANSI codes require ESC (7-bit) or CSI (8-bit) introducer.
	if (!value.includes("\u001B") && !value.includes("\u009B")) return value;
	return value.replace(ANSI_RE, "");
}

/** Drop control/format characters that break rendering (keep \t and \n). */
function sanitizeBinary(str: string): string {
	// Array.from iterates code points (not units), so surrogate pairs stay
	// intact and lone surrogates drop out.
	return Array.from(str)
		.filter((char) => {
			const code = char.codePointAt(0);
			if (code === undefined) return false;
			if (code === 0x09 || code === 0x0a) return true;
			if (code <= 0x1f) return false; // control characters
			if (code >= 0xfff9 && code <= 0xfffb) return false; // Unicode format chars
			return true;
		})
		.join("");
}

/** Sanitized display/copy form of a tool result text block. */
export function sanitizeOutputText(text: string): string {
	return sanitizeBinary(stripAnsi(text)).replace(/\r/g, "");
}
