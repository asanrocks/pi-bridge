# pi-bridge

pi-bridge runs pi Sessions behind a localhost daemon so browser and CLI clients
can observe and steer them. The browser is the primary UI; the protocol is UI-neutral.
Repository-wide development, Git, dependency, and release rules live in
[the root guide](../../AGENTS.md).

## Read for the task

Start with the [glossary](docs/glossary.md) and
[architecture](docs/architecture.md), including its invariants and test design.
Then read the docs for the area being changed:

| Area | Required documentation |
| --- | --- |
| `src/core/` | [Data model](docs/core/data-model.md), [protocol](docs/core/protocol.md), [sync](docs/core/sync.md) |
| `src/viewmodel/` | [Web architecture](docs/web/architecture.md); [sync](docs/core/sync.md) for pull/cache changes |
| `src/host/` | [Runtime](docs/host/runtime.md); [git stamps](docs/host/git-stamps.md) for stamp changes |
| `web/src/` | [Web architecture](docs/web/architecture.md) and [design](docs/web/design.md) |
| A proposed change | Relevant records in `docs/adr/`; proposals do not define current behavior |

## Package constraints

- Keep bridge as one package with browser-safe `core` and `viewmodel`, Node-only
  `host`, and the web client. Neither pure layer may depend on filesystem,
  network, DOM, terminal, or Node runtime APIs.
- New browser-safe modules must be exported from `src/index.ts` and exercised
  in the root `scripts/browser-smoke-entry.ts` so tree-shaking cannot hide them.
  The curated smoke gate resolves exports from `dist/`; changed exports need
  rebuilt output. Follow the root build-authorization rule.
- The web client intentionally imports `src/core/` and `src/viewmodel/`
  through source-relative paths for HMR. Symbols it consumes must also be
  public package exports. `./node` and `./cli` remain Node-only.
- Keep browser code under `web/src/`. Root TypeScript checking excludes `web/`;
  `check:bridge-web`, included in root `npm run check`, checks it separately.
- Always pass `streamingBehavior: "steer"` to `AgentSession.prompt()` so a
  prompt can be admitted while a turn is in flight.
- Read the web design rules before adding buttons, chips, or Markdown hosts.
  Use the shared styling tokens and rendering primitives; the root
  `scripts/check-bridge-styling-tokens.mjs` enforces the token boundary.
- Use the glossary's vocabulary. Add new coined terms there first, respect
  its domain-composition rule, and do not reintroduce retired words.

## Documentation ownership

Update owning docs in the same change:

| Changed source | Owning docs |
| --- | --- |
| `src/core/**` | `docs/core/` |
| `src/viewmodel/**` | `docs/core/` for sync; `docs/web/architecture.md` for projection |
| `src/host/**` | `docs/host/` |
| `web/src/{infra,app,render}/**` | `docs/web/architecture.md` |
| `web/src/features/**` | `docs/web/design.md` |

Permanent docs state current mechanisms and invariants; refresh them in place.
Keep file inventories in code headers, and status or planned work in ADRs or
issues. Do not add feature summaries to this guide.

ADRs progress through Proposed → Accepted → Implemented → Merged. Merge only
after implementation and verification: fold current behavior into permanent
docs, then delete the ADR. Git history retains rationale and alternatives;
deleted ADRs must not be cited as specifications of current behavior.
Choose a new ADR number after inspecting existing records.

## Verification

After code changes, run `npm run check` from the repository root as required
by the root guide. Bridge changes use the bridge suite; broaden to the root
`./test.sh` only for shared-package changes or failures outside bridge.
Builds and `npm test` require user authorization under the root guide.

From `packages/bridge/`:

| Purpose | Command |
| --- | --- |
| Focused test | `node ../../node_modules/vitest/dist/cli.js --run test/suite/<name>.test.ts` |
| Web types only | `node ../../node_modules/.bin/tsc --noEmit -p web/tsconfig.json` |
| Bridge suite, including web tests (when authorized) | `npm test` |
| Core/host/CLI build (when authorized) | `npm run build` |
| Web build (when authorized) | `npm run build:web` |
| Standalone binary (when authorized) | `npm run build:binary` |

Use `test/suite/harness.ts` for integration tests: fixture-resumed pi Sessions,
injected memory services, and a faux provider. No real provider APIs or paid
tokens. Pure unit tests use hand-built inputs. Manager patch callbacks are
the raw-object seam; initial replace is emitted through `addConnection`, not
a separate `onReplace` callback. See architecture's test design for convergence
and event-ordering checks.

## Debugging

`--log <path>` captures WebSocket frames as JSONL `{ ts, d: "in"|"out", frame }`.
`--dev` also relays browser `console.log`/`warn`/`error` calls through `console`
RPC frames when daemon information reports `devMode: true`.
