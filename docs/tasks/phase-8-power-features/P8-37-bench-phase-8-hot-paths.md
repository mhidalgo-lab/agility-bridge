---
id: P8-37
title: Bench scenarios and baseline for Phase 8 hot paths
phase: 8
status: todo
priority: low
depends_on: [P8-09]
adr: ["0010"]
lessons: [L-001, L-414]
owner: ""
---

# P8-37 — Bench scenarios and baseline for Phase 8 hot paths

> Filed by the Phase 8 review ([P8-12](P8-12-phase-8-review.md), `docs/reviews/phase-8-review.md`).

## Goal
Measure what the Phase 8 review could only derive (review P-9): the bench has the three query-cache rows and nothing for quota, tasks, telemetry, deep links, Apps views or the public catalogue.

## Scope
- Add scenarios to `scripts/worker-bench.ts`: a read with a quota set (statements and rows counted), a task create plus first poll, telemetry off and on (with a fake collector, flush each), `search_work_items` with 25 and 500 rows for the deep links, the Apps views registration, and the anonymous `tools/list`.
- Add a 100 KB and a 256 KB body to the shared-tier scenario (review P-1) and refresh the existing rows that every structured result now pays the deep links for.
- Record the baseline on a quiet machine (the review's runs were on a loaded one) and update the Measured cost table in `docs/guide/cloudflare-limits.md` with the Phase 8 rows.

## Acceptance criteria
- [ ] The new scenarios run in `pnpm bench:worker` and the baseline is refreshed on an idle machine.
- [ ] The Measured cost table and `docs/guide/query-cache.md` figures match.
- [ ] The unverified D1 row accounting is checked against `meta.rows_written` in the live pass (P8-13).

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-001
- L-414

## Docs to update
- docs/guide/cloudflare-limits.md, docs/guide/query-cache.md

## Out of scope
- Changing any cost.
