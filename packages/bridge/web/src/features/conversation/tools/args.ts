// ============================================================================
// Action-details argument helpers — the ToolArgs shape, the uniform details
// props, file-extension → language mapping, path display, and argument-value
// formatting for the fallback details renderer.
// ============================================================================

import { useCallback } from "react";
import type { ImageContent, JsonValue } from "../../../../../src/core/types.ts";
import type { ToolActionStepVM } from "../../../../../src/viewmodel/index.ts";
import { displayPath } from "../../../../../src/viewmodel/index.ts";
import { useStore } from "../../../infra/store.tsx";
import { sanitizeOutputText } from "./sanitize.ts";

/** Parsed tool arguments keyed by field name. Use type-narrowing at usage sites. */
export interface ToolArgs extends Record<string, unknown> {
	path?: unknown;
	command?: unknown;
	pattern?: unknown;
	content?: unknown;
	offset?: unknown;
	limit?: unknown;
	timeout?: unknown;
}

/**
 * Uniform props every tool details renderer accepts. Co-locates per-tool
 * argument extraction inside each body (the body knows its own arg shape) so
 * the dispatcher is a plain lookup with no per-tool branching — adding a tool
 * is one file plus one registry line.
 */
export interface ActionDetailsProps {
	step: ToolActionStepVM;
	args: ToolArgs | null;
	resultText: string | null;
	/** Image blocks from the tool result, in order. Empty when none. */
	resultImages: ImageContent[];
}

// ---------------------------------------------------------------------------
// Live arguments — store-direct so summaries/identities stream
// ---------------------------------------------------------------------------

/**
 * Live tool-call arguments for a step, read store-direct so they update as
 * the call's arguments stream in (the VM cache key excludes argument
 * values; the snapshot copy goes stale mid-stream). Falls back to the VM
 * snapshot while the entry is not yet in the document.
 */
export function useLiveArgs(step: ToolActionStepVM): JsonValue | null {
	return useStore(
		useCallback(
			(s) => {
				const entry = s.document.entries[step.entryId];
				if (!entry || entry.kind !== "message") return step.arguments ?? null;
				const block = entry.content[step.blockIndex];
				if (block?.type === "toolCall") return block.arguments ?? null;
				return step.arguments ?? null;
			},
			[step.entryId, step.blockIndex, step.arguments],
		),
	);
}

// ---------------------------------------------------------------------------
// Result text — sanitized display/copy form of the tool result
// ---------------------------------------------------------------------------

/**
 * Sanitized, trimmed tool-result text for a step (ANSI/binary/\r cleaned,
 * see sanitize.ts), or null while absent/empty. Subscribes to the result
 * entry's lazy-pulled content.
 */
export function useResultText(step: ToolActionStepVM): string | null {
	return useStore(
		useCallback(
			(s) => {
				if (!step.result) return null;
				const entry = s.document.entries[step.result.entryId];
				if (!entry || entry.kind !== "tool_result") return null;
				const raw = (entry.content ?? []).map((c) => (c.type === "text" && c.text) || "").join("\n");
				const text = sanitizeOutputText(raw).trim();
				return text || null;
			},
			[step.result],
		),
	);
}

// ---------------------------------------------------------------------------
// Edit-argument normalization (TUI prepareArguments parity)
// ---------------------------------------------------------------------------

function isSingleEdit(value: unknown): value is { oldText: string; newText: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const e = value as Record<string, unknown>;
	return typeof e.oldText === "string" && typeof e.newText === "string";
}

/**
 * Normalize edit-tool arguments for display: models sometimes emit `edits`
 * as a JSON string or a single edit object, or use the legacy top-level
 * `oldText`/`newText` pair. Mirrors the coding-agent's prepareEditArguments
 * so the card renders what the tool actually executed.
 */
export function normalizeEditArgs(args: ToolArgs | null): Array<{ oldText: string; newText: string }> | null {
	if (!args) return null;
	let edits: unknown = args.edits;
	if (typeof edits === "string") {
		try {
			const parsed: unknown = JSON.parse(edits);
			edits = Array.isArray(parsed) ? parsed : isSingleEdit(parsed) ? [parsed] : parsed;
		} catch {
			// malformed JSON — fall through to the legacy check
		}
	}
	if (isSingleEdit(edits)) edits = [edits];
	const list: Array<{ oldText: string; newText: string }> = [];
	if (Array.isArray(edits)) {
		for (const e of edits) {
			if (isSingleEdit(e)) list.push(e);
		}
	}
	// Legacy top-level pair appends to the normalized list (TUI parity).
	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		list.push({ oldText: args.oldText, newText: args.newText });
	}
	return list.length > 0 ? list : null;
}

// ---------------------------------------------------------------------------
// CWD hook — reads the open Project's cwd from the store (ADR 11)
// ---------------------------------------------------------------------------

/** Subscribe to the open Project's cwd. Returns null when no Project is open. */
export function useCwd(): string | null {
	return useStore(
		useCallback((s) => {
			if (!s.currentProjectId) return null;
			return s.projects.find((p) => p.id === s.currentProjectId)?.cwd ?? null;
		}, []),
	);
}

// ---------------------------------------------------------------------------
// Display path — strip the instance cwd prefix for project-relative paths
// Re-exported from the viewmodel (pure, browser-safe).
// ---------------------------------------------------------------------------

export { displayPath };

// ---------------------------------------------------------------------------
// File extension → language name
// ---------------------------------------------------------------------------

/** Map file extensions to language names for code fence language tagging. */
export function extToLang(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	const map: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		json: "json",
		md: "markdown",
		yml: "yaml",
		yaml: "yaml",
		toml: "toml",
		css: "css",
		html: "html",
		sh: "bash",
		bash: "bash",
		py: "python",
		rs: "rust",
		go: "go",
		sql: "sql",
		svg: "svg",
		xml: "xml",
		graphql: "graphql",
	};
	return map[ext] ?? "";
}

// ---------------------------------------------------------------------------
// Argument formatting
// ---------------------------------------------------------------------------

/** Format a single argument value for display */
export function formatArgValue(value: unknown): string {
	if (value === null || value === undefined) return "-";
	if (typeof value === "string") {
		return value.length > 80 ? `${value.slice(0, 77)}...` : value;
	}
	if (Array.isArray(value)) return `[${value.length} items]`;
	if (typeof value === "object") {
		const keys = Object.keys(value as Record<string, unknown>);
		return `{${keys.length === 1 ? keys[0] : `${keys.length} keys`}}`;
	}
	return String(value);
}
