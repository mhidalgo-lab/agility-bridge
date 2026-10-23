---
id: P4-05
title: Audit viewer and usage statistics
phase: 4
status: done
priority: medium
depends_on: [P4-03]
adr: ["0015"]
lessons: [L-041, L-065, L-097, L-121]
owner: "claude-agent"
---

# P4-05 — Audit viewer and usage statistics

## Goal
Owners and admins see what happened and how much the bridge is used; members see their own activity. Everything goes
through the admin API (in process), never through storage, and stays inside the free-plan limits of D1 (L-097).

## Scope

Admin API (`/api/admin/v1`), changed and added:

| Route | Who | Notes |
|---|---|---|
| `GET /audit` (changed) | owner, admin, break-glass: every row. **Member: only rows whose `userId` is theirs**, whatever the query says; asking for another `userId` is `403` | new `action` filter (exact tool or action name); same keyset cursor (`afterTs`, `afterId`), `limit` 1 to 1,000, newest first; the answer stays a JSON array (the CLI's `audit tail` reads it) |
| `GET /audit/stats` (new) | owner, admin | `groupBy` = `tool`, `workspace`, `grant`, `user`, `day`; `from`, `to`, optional `workspaceId`; `limit` 1 to 100 groups; answer `{ data, scanned, truncated }` |

Storage (`audit` repository), all three adapters, one contract suite:

- `AuditQuery.action`, and `stats({ groupBy, from, to, workspaceId?, limit? })`: `tool_call` rows only, one aggregate
  over at most `STATS_SCAN_CAP` (10,000) newest rows of the window (an inner `ORDER BY ts DESC LIMIT`), so rows read per
  call are bounded however long the window; per group: calls, errors, denied, Agility requests, duration sum, duration
  count (rows with a duration), slowest call. `truncated` says the cap cut the window short, never a silent zero (L-033).
- No new index: an index on `audit_log` costs a written row per audit append (D1 Free caps writes much lower than
  reads), and the default window bounds every scan. Recorded as D-37.

Panel (`packages/admin-ui/src/screens/audit.tsx`, `usage.tsx`):

- `GET /admin/audit` (all roles): filters time range (1 hour to 90 days, all retained), kind, status, tool or action,
  and for owner and admin also workspace and user; 50 rows per page, **keyset paging** through the API (fetches one extra
  row to know whether a next page exists; the cursor is validated in the panel and in the API); each stored string is
  auto-escaped text, `details` and queries cut for display; names for workspaces and users are looked up for display only.
  Members see their own rows and none of the owner filters.
- `GET /admin/audit.csv` (all roles, same filter): one API call of at most 1,000 rows, `text/csv`, `attachment`,
  `nosniff`, `no-store`; every cell quoted, formula-neutralised (leading `=`, `+`, `-`, `@`, tab, CR, LF, or one of them
  after white space gets an apostrophe); `X-Export-Truncated` when more rows matched; a cross-site navigation lands on
  the audit page instead of downloading.
- `GET /admin/usage` (owner, admin): window (24 hours to 30 days) and grouping (tool, workspace, grant, user, day);
  calls, errors, denied, mean and slowest duration, Agility requests, meters as `<meter>` (no inline style); the
  truncation notice; menu entries "Audit log" (everyone) and "Usage" (admins).

## Acceptance criteria
- [x] A member sees only their own rows: through the API and the panel, whatever `userId`, workspace, cursor or action they
      send; another `userId` is `403` and returns no row; role matrix of the screens equals the API's answers (test).
- [x] CSV export neutralises formulas (every leading trigger, after white space, inside quoted cells, quotes doubled,
      line breaks kept inside quotes) and carries the download headers; a cross-site navigation does not download (test).
- [x] Filters (time range, user, workspace, kind, status, action) narrow as stated on all three adapters, combine, and
      never widen a member's scope.
- [x] Keyset paging is stable while rows are inserted between pages: no row repeated or skipped (test, panel and storage).
- [x] Hostile strings (action, error code, query, details, target id, names) are inert on the audit and usage screens and in
      the CSV; the page never shows a secret the log does not hold (test scans for the planted token).
- [x] Bounded queries: page size capped, stats scan capped with `truncated`, `limit` and cursor validated; contract
      tests for the cap and the aggregates on memory, SQLite and D1 (workerd).
- [x] Negative authorization on every new route and screen: 401 without credentials, 403 for a member on usage and
      stats, no storage read on denial (test).
- [x] A workerd smoke renders the audit and usage screens against D1.
- [x] Key security tests are mutation-checked (L-121), recorded under Outcome.
- [x] `docs/guide/audit-log.md` and `docs/guide/admin-panel.md` updated, `docs/dev/admin-ui.md`, THREAT_MODEL (T13, T17),
      the admin API reference (generated) and a changeset.

## Security notes
THREAT_MODEL T13 (escaping, CSV), T17 (the log stays append-only; the viewer only reads), T8 (rows hold masked queries
and asset numbers, never secrets), T3 (a member's view is bound to their own id by the server).

## Lessons applied
- L-041 — Neutralise spreadsheet formulas.
- L-065 — Every alternate reader and writer is an authorization boundary: the member scope lives in the API.
- L-097 — Free-plan limits: bounded scans, one export call.
- L-121 — Negative authorization is first-class.

## Docs to update
- docs/guide/audit-log.md, docs/guide/admin-panel.md, docs/dev/admin-ui.md, docs/reference/admin-api.md (generated),
  docs/THREAT_MODEL.md

## Out of scope
- Member self-service pages and "my audit" links (P4-07), quota usage (Phase 7), per-user statistics for members, an
  `audit.export` audit row, streaming or chunked exports beyond 1,000 rows, charts, alerting.

## Outcome

- **Built**: `GET /admin/audit` and `/admin/audit.csv` (all roles; members own rows) and `GET /admin/usage` (owner, admin) in
  `packages/admin-ui/src/screens/{audit,usage}.tsx`, menu entries, `Pager` with a "Newest entries" link, `<meter>` style, parsers in
  `data.ts`, regenerated assets.
- **Admin API**: `GET /audit` open to members, scoped to their own user id by the server (another `userId` is 403), new `action`
  filter; new `GET /audit/stats` (owner, admin; `{ data, scanned, truncated }`). The response of `/audit` stays an array.
- **Storage**: `AuditQuery.action`; `audit.stats({ groupBy, from, to, workspaceId, limit, scanCap })` on memory and SQL (SQLite and
  D1), `STATS_SCAN_CAP` = 10,000; no migration, no new index (D-37).
- **Tests**: storage contract (action filter, keyset paging under inserts, aggregates, window, scan cap, validation) on memory, SQLite
  and D1; `packages/http-app/test/admin-audit.test.ts` (18: role matrix, member scope, filters, paging stability across 3 pages
  with rows arriving, hostile strings, secrets scan, CSV headers and formula neutralisation, 1,000-row cap, cross-site download,
  usage, bounded reads, 401/403 reading nothing); `packages/admin-ui/test/audit-screens.test.tsx`; workerd smoke in
  `apps/worker/test/worker.test.ts` (audit, CSV, usage and stats against D1).
- **Mutation checks (L-121)**: 16 deliberate reversions each fail a test: member scope not forced, member may ask for another
  userId, stats open to members, CSV not neutralised, neutralised only for a leading sign, cross-site CSV navigation downloads, next
  cursor from the first row, panel sends the member's user filter, usage page open to members, page without the extra row, stats
  count every kind, scan cap ignored, `action` filter ignored, workspace filter ignored (memory), details not cut, names looked up
  for members.
- **From relic-bridge's P4-05**: keyset paging with a validated cursor, formula-neutralising CSV, cross-site download redirect,
  bounded aggregate with a group cap; adapted: no OFFSET, truncation reported, export a single bounded call (L-097), no per-id name
  lookups beyond workspaces and users.
- **Not done on purpose**: members' own statistics, an `audit.export` audit row, exports over 1,000 rows (see Out of scope).
