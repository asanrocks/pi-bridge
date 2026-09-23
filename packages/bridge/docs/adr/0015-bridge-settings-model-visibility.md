# ADR 0015: Bridge Settings File and the Model Picker's Tiers

**Status:** Implemented.

## Context

The model picker has exactly one curated group. It is pi's `enabledModels`
scope: the Project home reads the daemon's global scope from `getDaemonInfo`,
and an attached Session reads its Document's resolved scope. Every other
catalogue model falls into a provider group, ordered by provider size. With a
large catalogue the models a user browses are buried.

Two changes are wanted:

- A **normal / folded** split so the long tail can be hidden, configured with
  minimatch patterns (`visibleModels`).
- An explicit **pin** control that tunes the curated group.

pi's `Settings` has no `visibleModels` field, and the project constraint is
**no pi-core changes**: bridge must not add a field or setter to
`packages/coding-agent`. pi's `SettingsManager` does expose
`setEnabledModels` (global), which the TUI's `/models` selector already uses
to persist the pinned scope.

The previous code also carried a per-Session concept: `Document.pinnedModels`
was resolved from the *merged* (global + project) settings, and the Manager
called `session.setScopedModels`, which makes pi's `setModel` implicitly
append every picked out-of-scope model to the global `enabledModels`. That is
two concepts (session and global) and an implicit mutation behind a control
that should be explicit.

## Decision

### One concept: daemon-global pinned models

Pinned models is a single daemon-global list, backed by pi's **global**
`settings.json` `enabledModels`. Bridge never reads a project-level
`.pi/settings.json` override, and the list is not Document state:
`Document.pinnedModels` and the `/pinnedModels` initial-sync op are removed.
The client holds the list in the store (`pinnedModels`) for both the Project
home and an attached Session; `getDaemonInfo.pinnedModels` seeds it and the
`pinned_models_changed` push refreshes it.

Pinning is explicit. The Manager no longer calls `session.setScopedModels`, so
pi's implicit `_addPersistedDefaultToNonEmptyScope` never fires; a model is
pinned only by the control below.

### The pin control

`setModelPinned { provider, modelId, pinned }` is a daemon verb. The host
reads the raw global `enabledModels`, resolves it to concrete ids (pi's TUI
normalizes globs the same way on save), adds or removes the one model,
persists via `setEnabledModels` + `flush`, and broadcasts
`pinned_models_changed { pinnedModels }` to every Connection. The reply is
acknowledgement only; the push is the state channel. The picker reveals each
row's `provider/modelId` on hover and renders a ghost pin toggle (Shift+Enter
for the keyboard-focused row).

### A bridge-owned preferences file for `visibleModels`

`<agentDir>/bridge/settings.json` is a bridge-owned preferences file, separate
from pi's `settings.json`, so bridge needs no pi setter for this key:

```json
{ "visibleModels": ["anthropic/claude-*", "openai/gpt-5"] }
```

`visibleModels` is an array of canonical `provider/modelId` patterns, stricter
than pi's `enabledModels` dialect: the pattern is matched with minimatch,
case-insensitively, against the full `provider/modelId` reference. `/` is a
path separator, so `*` stays within a segment and `**` crosses them: `deepseek/*`
selects the models DeepSeek serves and never an OpenRouter-routed
`openrouter/deepseek/...` model, while `**/claude-*-5*` reaches a routed
`openrouter/anthropic/claude-…`. A pattern without `/` matches nothing. An
optional `:thinkingLevel` suffix is stripped, because visibility is about the
model, not the level. A missing or malformed file, an
absent key, or an empty array means **no filter**: every non-pinned model is
normal and nothing folds.

Resolution happens host-side, against the catalogue `getDaemonInfo` already
returns. The reply's `visibleModels` is the list of resolved
`provider/modelId` keys, so the browser needs no glob engine and the matching
dialect stays in one place (`src/host/model-visibility.ts`). Bridge reads the
file on each `getDaemonInfo`; there is no watcher, so an edit is picked up at
the next connection. Editing it from the UI is deferred: the setting is
hand-edited for now, and because the file is bridge-owned a future writer
needs no pi change.

### Three tiers

The picker partitions the catalogue into:

- **Pinned** — the daemon-global list. Top group, cycle-able. Omitted when
  empty; there is no Suggested fallback.
- **Normal** — catalogue models matching a `visibleModels` pattern, plus every
  pinned model (pinning is a promotion), in provider groups.
- **Folded** — the rest, hidden per provider behind that group's `More…` row
  and revealed in place.

Each provider group holds that provider's whole catalogue, so a pinned model is
never missing from its list; it repeats in the Pinned group above. A pinned
model is always normal — never folded, even when `visibleModels` excludes it.
Searching bypasses the tiers: the curated group hides and every match stays
findable in its provider group, folded models included.

## Consequences

- The three tiers live in `buildModelGroups`, a pure function, so the portal
  stays a render shell and the partition is unit-tested.
- Two model-related config files coexist: pi's global `enabledModels` (pinned)
  and bridge's `visibleModels` (normal). The split is deliberate — it keeps
  bridge self-contained under the no-pi-change constraint.
- Because the hosted list is global, an attached Session's pinned list is the
  same as the Project home's; a project-level `enabledModels` override in pi
  is deliberately not reflected.
- A malformed `visibleModels` pattern matches nothing, so a typo degrades to
  "everything folds" rather than an error; folded models stay reachable
  through the disclosure, so the mistake is visible and recoverable.
- Reading is resilient by construction: a missing, unreadable, or malformed
  preferences file yields no preference and never fails daemon startup.
