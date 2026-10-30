---
id: P8-37
title: Bench scenarios and baseline for Phase 8 hot paths
phase: 8
status: review
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
- Add scenarios to `scripts/worker-bench.ts`: a read with a quota set (statements counted; rows are a D1 figure and stay with the live pass), a task create plus first poll, telemetry off and on (with a fake collector, flush each), `search_work_items` with 25 and **200** rows for the deep links (the default row cap is 100, so the scenario raises it; 200 rather than 500 keeps the run short and still shows the per-row slope, which is what [P8-40](P8-40-deep-links-per-row-cost.md) needs), the Apps views registration, and the anonymous catalogue (`tools/list` and `initialize`).
- Add bodies of 8, 64, 100 and 256 KB to the shared-tier scenario (review P-1; the 64 KB row also serves [P8-38](P8-38-shared-tier-size-and-cpu.md)). The existing rows already pay for deep links: they are the same run's comparison, not rewritten.
- Record the baseline on a quiet machine (the review's runs were on a loaded one) and update the Measured cost table in `docs/guide/cloudflare-limits.md` with the Phase 8 rows. A figure taken on a loaded machine goes in the table only marked *local, indicative*.

## Acceptance criteria
- [x] The new scenarios run in `pnpm bench:worker`.
- [ ] The baseline (`scripts/bench/worker-baseline.json`) is refreshed on an idle machine (owner step: the figures taken while building this were on a loaded one, so the baseline file is not rewritten).
- [x] The Measured cost table and `docs/guide/query-cache.md` figures match (marked local and indicative until the idle-machine run).
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
