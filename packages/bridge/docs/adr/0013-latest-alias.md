# ADR 0013: The `@latest` alias

**Status:** Implemented

## Context

Users want a bookmarkable address that always opens the most recent session,
across all Projects — "show me the live one" — without hunting through the
launcher after every daemon restart. The URL model (ADR 11) makes the URL the
navigation source of truth: it is read at boot and every reconnect, and
address-bearing initial-sync frames commit `(projectId, stem)` back into it.
A cross-Project "latest" target is time-dependent, which cuts against two
invariants if done naively: the URL would have to redirect to the resolved
address (breaking bookmarkability — the bookmark degenerates to a one-shot),
or the URL would stop determining what is displayed.

## Decision

An **alias** is a first URL segment beginning with `@`, forming a second
address namespace alongside Project ids:

- `/@latest` resolves, once per boot/reconnect, to the most recently active
  **live** session — the first row of the global active-session snapshot the
  client already fetches at initialization and keeps fresh via
  `active_sessions_changed` pushes. When no session is live (e.g. right after
  a daemon restart) it falls back to the most recent **durable** session
  across Projects — each Project's first `listSessions` row — and opens it,
  which activates it; only when no session exists at all does it fall back to
  the launcher. **No daemon-side support exists**: no new verb, no reply
  field; the fallback reuses the Project-scoped `listSessions` verb the client
  already has. (The launcher's Latest row — the live snapshot's first row —
  still disappears when nothing is active.)
- **The URL never redirects.** While the session was reached through the
  alias, the store holds the resolved address and the pipeline suppresses the
  route write on address-bearing initial-sync frames. The URL stays `/@latest`
  — bookmarkable, time-dependent by design.
- **No dynamic switching.** Resolution happens only in the boot/reconnect
  path. A reconnect re-reads the URL and re-resolves; a connected client never
  re-resolves.
- **Escape hatch.** Any explicit navigation (open a session, a Project home,
  detach, a first prompt) clears the alias view and commits a real URL from
  then on. A failed alias open falls back to the resolved Project's home —
  an explicit URL.
- **Discovery.** The launcher renders a "Latest" row above the Project list —
  literally the active list's first row, for all Projects.
- **No reservation.** Project ids match `^[a-z0-9]+(-[a-z0-9]+)*$`; `@` is
  outside that charset, so the alias namespace is structurally disjoint from
  Project ids. A Project literally named "latest" keeps working, including
  its `/latest` home URL. Aliases are single-segment; `/@x/...` is not an
  alias route and falls back to the launcher.

## Alternatives considered

- **Daemon-side durable resolution** (a cross-Project newest-session scan —
  e.g. a `latest` field on `getDaemonInfo`, or `listSessions` per Project).
  Rejected twice over: the scan costs a full pass over every Project's
  session tree on every connection boot for a once-per-boot query, and
  "most recent session" including dormant ones is the wrong semantics for
  the bookmark anyway — a dormant session is an old conversation, findable
  in the sidebar, while the alias's promise is "the live one." The active
  snapshot already exists, is already cross-Project, is already refreshed by
  pushes, and is the launcher's own ordering. (Amended after implementation:
  with no live session the client now does scan each Project's first
  `listSessions` page and treats a dormant session as the target — the
  bookmark must open *something* after a daemon restart. The scan is paid only
  on that no-live-session path.)
- **Reserve the id `latest`** (as web-asset names are reserved). Rejected:
  the reserved set there is closed and derived from real assets; an alias set
  grows, and every growth would be a breaking startup rejection for someone's
  existing config. Making collisions impossible beats managing them.
- **A redirect** from `/@latest` to the resolved address. Rejected: the
  bookmark stops being "latest" after first use, which is the feature.
- **Prefer streaming sessions in the ordering.** Rejected: "most recent"
  should mean one thing — last activity — and a streamer tops the snapshot
  by that ordering anyway.

## Consequences

- The URL→session mapping becomes time-dependent for alias URLs. This is the
  feature, not a bug, but it means two tabs on `/@latest` can show different
  sessions. The alias form is never written into `addressIndex` or used as a
  cache key — those stay keyed on the resolved address.
- After a daemon restart with nothing active, `/@latest` opens the most
  recent durable session (activating it). This costs one `listSessions` call
  per Project, paid only on the no-live-session path.
- A new alias is a cross-cutting change (route grammar, boot path, launcher)
  and a glossary claim first.
