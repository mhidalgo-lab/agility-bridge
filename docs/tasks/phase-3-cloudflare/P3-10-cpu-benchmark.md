---
id: P3-10
title: CPU benchmark and cost check
phase: 3
status: done
priority: low
depends_on: [P3-03]
adr: ["0010"]
lessons: [L-020, L-097]
owner: ""
---

# P3-10 — CPU benchmark and cost check

> Refined 2026-10-22 (tasks/README rule 7).

## Goal
Know the CPU and request cost of each tool on Workers and catch regressions.

## Scope
- `pnpm bench:worker` (`scripts/worker-bench.ts`): CPU of the Worker's code paths in Node (the same V8 as workerd,
  P0-09): the **cold boot** (settings, keyring and key derivation, key check, admin token, app assembly, first request)
  measured in fresh child processes, and **warm** `tools/list`, `whoami`, `search_work_items` and `get_work_item` against
  Agility-shaped fake responses, with the Agility requests each call used. Costs are also expressed as multiples of a
  fixed calibration workload measured in the same run, so runners of different speed compare.
- `scripts/bench/worker-baseline.json` (committed) and a regression check: a path whose relative cost grows past 2×
  its baseline is flagged (exit 1); `--update` rewrites the baseline.
- A non-required CI job runs it on every PR and uploads the JSON as an artifact (history).
- Production figures from staging (`wrangler tail` CPU time) recorded with the local ones in
  `docs/guide/cloudflare-limits.md`.

## Acceptance criteria
- [x] Local and staging numbers published in `docs/guide/cloudflare-limits.md`; the cold-start finding (over the Free
      plan's 10 ms) recorded with a follow-up task (P3-14).
- [x] The regression check flags a slowed path in a test (an injected slowdown) and passes on the baseline.
- [x] The CI job runs (not required) and keeps the results as an artifact.

## Security notes
THREAT_MODEL T5, A10.

## Lessons applied
- L-020 — Cache converted tool schemas.
- L-097 — Design for the Free plan's limits, not its tolerance.

## Docs to update
- docs/guide/cloudflare-limits.md

## Out of scope
- Reducing the cold-start CPU (follow-up task); remote tool calls on staging (it reaches no Agility, D-01).
