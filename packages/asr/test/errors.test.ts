/**
 * The error taxonomy is part of the public contract: `code`, the raw `status`,
 * and the `retryable` hint that `docs/protocol.md` §7.1 requires on every
 * failure. These assertions are per-code rather than per-message so a caller can
 * branch without matching text.
 */
import { describe, expect, it } from "vitest";
import type { AsrErrorCode } from "../src/errors.ts";
import { AsrError, codeForStatus, isAuthExpired, retryableForStatus, ServerStatus } from "../src/errors.ts";

describe("errors / status mapping", () => {
	it("recognises the routine expired-token case", () => {
		expect(isAuthExpired(ServerStatus.authExpired)).toBe(true);
		expect(isAuthExpired(ServerStatus.startTaskExpected)).toBe(false);
		expect(isAuthExpired(ServerStatus.noAccessRight)).toBe(false);
		expect(isAuthExpired(undefined)).toBe(false);
	});

	it("maps the measured statuses onto the taxonomy", () => {
		expect(codeForStatus(ServerStatus.authExpired)).toBe("auth_expired");
		expect(codeForStatus(ServerStatus.startTaskExpected)).toBe("protocol");
		expect(codeForStatus(ServerStatus.noAccessRight)).toBe("server");
	});

	it("never swallows an unknown status", () => {
		// §7.1: pass unknown codes through instead of translating them away.
		const status = 4_029_999;
		expect(codeForStatus(status)).toBe("server");
		const error = new AsrError("server", "unknown", {
			status,
			retryable: retryableForStatus(status),
		});
		expect(error).toMatchObject({ code: "server", status, retryable: true });
	});
});

describe("errors / retryable", () => {
	/**
	 * The whole taxonomy, so adding a code without deciding its retry semantics
	 * fails here rather than in a caller's UI.
	 */
	const EXPECTED: Record<AsrErrorCode, boolean> = {
		auth_expired: true,
		connection: true,
		timeout: true,
		expired: true,
		capture: true,
		protocol: false,
		server: false,
		config: false,
		unsupported: false,
		aborted: false,
	};

	it("defaults per code", () => {
		for (const code of Object.keys(EXPECTED) as AsrErrorCode[]) {
			expect(new AsrError(code, "x").retryable, code).toBe(EXPECTED[code]);
		}
	});

	it("classifies the known statuses explicitly", () => {
		expect(retryableForStatus(ServerStatus.authExpired)).toBe(true);
		// A wire-format mismatch and a permission denial both fail identically on a
		// second attempt, so offering a retry would be a lie.
		expect(retryableForStatus(ServerStatus.startTaskExpected)).toBe(false);
		expect(retryableForStatus(ServerStatus.noAccessRight)).toBe(false);
		expect(retryableForStatus(ServerStatus.ok)).toBe(false);
	});

	it("lets an in-band status refine the code default", () => {
		const error = new AsrError("server", "no access right", {
			status: ServerStatus.noAccessRight,
			retryable: retryableForStatus(ServerStatus.noAccessRight),
		});
		expect(error.retryable).toBe(false);
	});

	it("honours an explicit override", () => {
		expect(new AsrError("timeout", "x", { retryable: false }).retryable).toBe(false);
		expect(new AsrError("config", "x", { retryable: true }).retryable).toBe(true);
	});
});
