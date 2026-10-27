---
id: P6-01
title: Portfolio tools (epics and portfolio items)
phase: 6
status: review
priority: high
depends_on: [P2-17]
adr: ["0015"]
lessons: [L-035, L-043, L-148]
owner: "agent (P6-01)"
---

# P6-01 — Portfolio tools (epics and portfolio items)

> Refined 2026-10-27 (tasks/README rule 7): scope and acceptance criteria below replace the sketch.

## Goal
See the portfolio tree and its progress without hand-written queries.

## Scope
- `list_portfolio_items` (group `portfolio`, read, paged): `Epic` assets with their category (Feature, Initiative and so
  on are values of `Epic.Category`, never asset types, L-148), status, parent epic (`Super`), estimates and the number of
  live direct children. Filters: `category` (names), `project`, `status` names, `contains`, `parent` (an epic number or
  OID, validated to be an epic), `include_closed`; sorted by `id` or `name`.
- `get_portfolio_tree` (group `portfolio`, read, not paged): one epic (`asset`, number or OID; any other asset type is
  refused before another request, L-035) with its descendant epics down to `depth` levels (default 2, at most 4, one
  request per level) and **roll-ups** per epic over the backlog items (stories and defects, through `Super`) of that epic
  and of its fetched descendants: item counts, done items, open defects, estimate, done estimate and done percentage
  (by estimate when any item has one, otherwise by item count, and the basis is stated). Closed items count as done;
  dead assets are never counted. `include_items` (default false) also lists the backlog items, capped.
- Honest `partial` with a note naming the cause: the depth cut (epics exist below the last level, probed with one more
  request), a level or item list cut by `max_items`, a type the workspace does not allow (its items are left out of the
  roll-ups and the roll-ups say so), rows outside the workspace's Agility projects (`hiddenOutsideScope`). A roll-up
  over a cut set is marked `incomplete` on that epic, never shown as exact.
- Every value from Agility (names, statuses, categories) goes through the output shaper and the envelope on the text
  and structured paths; scope stays the server's top-level restriction; the `Super` values sent upstream are OIDs taken
  from earlier responses and bound as `with` variables.
- Add the group to the stdio defaults (`portfolio` is on by default, catalogue), regenerate the tool reference, set the
  catalogue costs to the measured ones.

## Acceptance criteria
- [x] `list_portfolio_items`: category, status, project, parent and name filters; identity on every row (number,
      assetType, oid, state, project); paging with a cursor bound to the filters; denied `Epic` type refused.
- [x] `get_portfolio_tree`: synthetic fixture with three portfolio levels (Initiative, Feature, Feature) and backlog
      items; roll-ups exclude dead assets and count closed items as done; open defects counted; done percentage basis
      stated; non-epic assets refused with no further requests.
- [x] `partial` is set and explained for a depth cut, a `max_items` cut and a denied item type; `incomplete` roll-ups
      are marked.
- [x] Negative authorization tests: an epic outside the workspace answers not found; children in other projects are
      dropped and reported; a denied type makes no upstream call; an upstream that ignores filters leaks nothing.
- [x] Poisoned upstream text stays inside the envelope on every output path (probe test); declared costs hold on a cold
      cache (cost test); contract, naming and size lints pass.
- [x] Live (guarded suite, third-party tenant, shapes and coarse levels only): both tools run against the tenant and the
      result shapes are asserted; nothing from the tenant is printed or committed.
- [x] Catalogue, tool reference (generated), verification page and THREAT_MODEL (A4 row) updated; changeset added.

## Security notes
THREAT_MODEL A4.

## Lessons applied
- L-035 — Validate at the domain level before calling upstream.
- L-043 — Keep identity on every row.
- L-148 — Learn the model from metadata, then verify relations live.

## Docs to update
- docs/reference/tools.md (generated)
- docs/reference/tool-catalogue.md (costs, wording)
- docs/dev/verification.md (live run)
- docs/THREAT_MODEL.md (A4 coverage)

## Out of scope
- Anything not listed under Scope: Goals, Themes, Requests, writes on epics (Phase 7) and `release_readiness` (P6-07).
