---
id: P6-07
title: Composite reports
phase: 6
status: in-progress
priority: high
depends_on: [P6-01, P6-02, P6-05]
adr: ["0015"]
lessons: [L-033, L-037, L-114]
owner: "agent (P6-07)"
---

# P6-07 — Composite reports

## Goal
One-call reports that save agents many round trips and stay honest about gaps.

## Scope
- Group `reports` (read, **off by default**): offered only when the workspace limit `reports` is on and the grant keeps
  it on (a grant can only turn it off); stdio: `AB_REPORTS` / `reports:` in the workspace YAML. Same gating model as
  `attachments` (D-101).
- A composite is a thin layer over its siblings' handlers, called with the call's own context and one shared budget
  (never duplicated query code). Each section names the sibling tool it reads through. A section whose tool is not
  granted to the caller is **skipped with a note and never run** (the host tells the server which tools the caller may
  call, `ToolContext.grantedTools`, fail closed); a section that fails (upstream error, budget) is reported as
  `failed`/`not_run` with its error code; the first section's error is rethrown only when no section succeeded.
  Everything a section did not read is absent from the numbers, never zero (L-033).
- `sprint_health` (`get_sprint` + `search_work_items`): pace (done share against elapsed time of the sprint), scope
  change, unestimated and unowned open items, open defects, in-progress items not changed for 3 days. Status
  `on_track | at_risk | off_track | unknown`; `unknown` whenever pace cannot be computed.
- `standup_summary` (`search_work_items` twice): for a member (default `me`) and an optional team or project: items
  changed since a point in time (default last 24 hours, UTC; closed included) and items in progress. Blockers are not
  reported (no blocked flag is read) and the report says so.
- `release_readiness` (`get_portfolio_tree`): for an epic (the release container): roll-ups over its sub-epics, open
  backlog items and open defects, unestimated items. Verdict `ready | not_ready | unknown`; `ready` only when nothing
  open was read and nothing was cut.
- `defect_triage` (`search_work_items`): open defects of a project, team or sprint: unowned, unplanned (no sprint),
  stale (no change for 14 days), age by last change, likely duplicates by name similarity (computed on the rows read).
- `work_item_quality` (`get_work_item` + one guarded priority read): scores one backlog item or defect with the
  versioned rubric (`BACKLOG_ITEM_QUALITY_RUBRIC`, D-92) and cites its version. Criteria that cannot be assessed from
  what was read are `null`; the result then carries a score range and a level only when the range stays inside one
  level. Resource `agility-bridge://rubrics/backlog-item-quality` lists the tool in `uses`.
- Declared worst-case costs are the sum of the sections' declared costs, tested cold (L-114).

## Acceptance criteria
- [ ] Each report is tested with missing grants (section skipped with a note, sibling not called), empty data, budget
  exhaustion, partial upstream failures; no plausible zeros.
- [ ] Reports are absent from `tools/list` and refused by name unless the workspace limit is on and the grant keeps it
  on; stdio needs `AB_REPORTS`.
- [ ] Negative authorization: denial answers with no upstream call and no data; scope is enforced on every row (through
  the siblings); a section never reads with a tool the caller does not hold.
- [ ] Poisoned-text probe passes on every report (titles, names, descriptions, statuses reach text and structured
  output only through the shaper).
- [ ] Cold cost tests: each report's declared cost covers the requests it makes on a cold cache.
- [ ] The rubric is the one in `packages/core/src/rubric.ts`; the resource lists `work_item_quality` in `uses`.
- [ ] Live (guarded suite): shapes and levels only.
- [ ] `tools/list` stays inside the budgets (default and every group); generated references, threat model, lessons,
  decisions and a changeset updated.

## Security notes
THREAT_MODEL T3, A1: scope is enforced by the siblings on every row; a composite never widens it and never calls a tool
the caller was not granted (L-037).

## Lessons applied
- L-033 — Never turn missing data into zeros or confident claims.
- L-037 — Composite tools need their own authorization and cost model.
- L-114 — Declared costs cover the worst case.

## Docs to update
- docs/reference/tools.md (generated), docs/reference/tool-catalogue.md, docs/guide/configuration.md,
  docs/THREAT_MODEL.md, docs/pending-decisions/phase-6.md

## Out of scope
- Batch quality scans over a sprint or epic (P6-29), defect priority and severity in triage (P6-30), MCP Tasks for
  long reports, write tools.
