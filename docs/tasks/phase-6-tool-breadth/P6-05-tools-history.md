---
id: P6-05
title: History and activity tools
phase: 6
status: done
priority: medium
depends_on: [P2-17]
adr: ["0011"]
lessons: [L-060, L-146]
owner: "agent (P6-05)"
---

# P6-05 — History and activity tools

## Goal
Answer "what changed and when" from the authoritative history, with every window bounded before any request is sent.

## Scope
- `get_asset_history` (group `history`, read): one asset by number or OID token; reads `rest-1.v1/Hist/<type>/<id>`
  (JSON) with a validated attribute selection, diffs consecutive versions and returns one row per changed field
  (`changedAt`, `changedBy`, `field`, `from`, `to`), newest first. Arguments: `asset`, `time_range` (default
  `last 30 days`, at most `maxTimeRangeDays`, L-061), `fields` (at most 10 attribute paths, validated through the query
  compiler; paths reached through project-bound relations are refused because history rows cannot be scope-guarded),
  `limit` (at most `maxRows`), `format`. Not paged: `truncated` when more changes exist in the window.
- `list_recent_changes` (group `history`, read): work items (Story, Defect, Task, Test) of an Agility project, a team,
  or the whole workspace changed inside a `time_range` (default `last 7 days`), newest change first through
  `query.v1` with bound `ChangeDate` filters, scope predicate and recheck. Arguments: `project`, `team`, `asset_type`,
  `time_range`, `include_closed`, `limit`, `cursor`, `format`. Paged. Says which version of an item changed, not what
  changed (use `get_asset_history`).
- The activity stream is **not read** (not authoritative, L-146; outside the live guard; recorded as D-89). Tool text
  says so.
- `asof` point-in-time reads stay in `query_assets` (`as_of`, bounded by `maxAsOfAgeDays`).

## Acceptance criteria
- [x] `get_asset_history` and `list_recent_changes` follow the tool conventions (names, `time_range`, output contract,
  costs declared and measured, lints green).
- [x] Windows and limits are validated before any Agility request: a window longer than `maxTimeRangeDays`, one that
  ends before it starts, an unparseable one, a `limit` above `maxRows` and more than 10 fields each fail with no
  upstream call (unit tests count requests).
- [x] History values are untrusted: titles, names, statuses and field values go through the output shaper and envelope
  (poisoned-string probe on both tools); no `node:*`, no string-built queries.
- [x] Negative authorization: an asset outside the workspace's projects or of a denied asset type answers not found or
  forbidden with no `Hist` request and no data; project and team filters cannot widen the scope; rows an upstream
  returns outside the scope are hidden.
- [x] Diffs are correct (first version, unchanged versions, multi-value fields, window edges inclusive/exclusive).
- [x] Live (guarded, read-only tenant): the latest history version agrees with the current `Data`/query value of the
  selected fields; shapes and coarse levels only recorded. "History matches known edits" cannot be checked on the
  third-party tenant: recorded as a gap for the writable sandbox ([P6-21](P6-21-history-sandbox-verification.md)).
- [x] `pnpm docs:tools` refreshed; catalogue, RESEARCH (Hist shape, unverified items), lessons and a changeset updated.

## Security notes
THREAT_MODEL T3/T4/T9: scope enforced before and after (resolver and recheck), no string-built URLs (the client
validates type, id and selection), history text is untrusted data. No new route or write.

## Lessons applied
- L-060 — Bound time and history before the request.
- L-146 — The activity stream is not authoritative.

## Docs to update
- docs/reference/tools.md (generated), docs/reference/tool-catalogue.md, docs/RESEARCH.md, docs/dev/verification.md
  (live gap), docs/pending-decisions/phase-6.md

## Out of scope
- The activity stream, `asof`-based history reconstruction, history of asset types other than the four work-item types
  for `list_recent_changes`, write tools.
