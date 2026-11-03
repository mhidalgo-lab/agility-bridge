---
id: P9-03
title: Performance and cost review
phase: 9
status: in-progress
priority: medium
depends_on: [P8-12]
adr: ["0010"]
lessons: [L-097, L-114]
owner: ""
---

# P9-03 — Performance and cost review

> Refined 2026-11-03 (tasks/README rule 7). Depends on P8-12, waived by the owner on 2026-11-03 (live pass pending).

## Goal
Publish realistic latency, request and cost numbers per tool and deployment mode, and keep them from regressing.

## Scope
- Start from `pnpm bench:worker` and its baseline (`scripts/bench/worker-baseline.json`): extend it from a handful of
  tools to every read tool (warm CPU, cold and warm Agility requests, declared cost against measured worst case, L-114).
- Latency p50/p95 per tool on **Node stdio**, **Node HTTP** (`agility-bridge serve`) and a **Worker** (staging, Free plan),
  against a mock Agility with Agility-shaped data and a documented latency model (P0-06 measurements). Never a real tenant.
- Workers numbers: CPU ms per request (`wrangler tail`), D1 operations; derive the Paid column from Cloudflare's
  documented limits (cited with URL and date in RESEARCH) and mark derived numbers as derived.
- Re-tune budgets and caps where the numbers say so (a decision if a default changes).
- A regression mechanism: the CI bench job also flags request-count growth; a deterministic test pins per-tool requests.

## Acceptance criteria
- [x] The bench covers every read tool; a deterministic test pins the measured requests per tool to the baseline and to
  the declared cost.
- [x] A per-tool budget table is published (`docs/reference/performance.md`, generated from committed results): latency
  p50/p95 per mode, Agility requests (cold, warm), Workers CPU ms, D1 operations, declared cost against measured worst case.
- [x] Latency measured on Node stdio, Node HTTP and the Free-plan Worker with the mock upstream; the raw results are
  committed (`scripts/bench/perf-results.json`) with the date and the method.
- [x] Cloudflare limits for Free and Paid cited from the current docs in `docs/RESEARCH.md` (URL, date); Paid numbers marked derived.
- [x] Budgets and caps reviewed against the numbers; any default change recorded as a decision (or "no change" recorded).
- [x] Regression tracking: the CI bench job flags request growth as well as CPU growth; documented.
- [x] `docs/guide/cloudflare-limits.md` and `docs/guide/query-limits.md` updated.
- [x] Every spike Worker created is deleted and the deletion recorded.
- [ ] *owner:* a run against a live Agility tenant (real latency) and on a Paid account (measured Paid numbers).

## Done (2026-11-03)
- Cloudflare, within the owner's permission: `agility-bridge-staging` (Worker and D1 of that name) did not exist any more, so
  `pnpm cf:setup --name agility-bridge-staging` created both (Free plan, secrets in a file outside the repository); the mock
  Agility ran as `agility-bridge-spike-perf-mock` and **was deleted** (`wrangler delete`, verified 404); the perf workspace,
  credential and instance were removed from staging. Staging stays deployed on `AB_PLAN=free`. About 1,000 Worker requests
  in all. No account id, token or URL with a secret was committed.
- Findings and decisions: D-356 to D-360 (`docs/pending-decisions/phase-9.md`); lessons L-491 to L-494; follow-ups P9-15 to
  P9-18. Numbers: `docs/reference/performance.md`, `docs/guide/cloudflare-limits.md`, `docs/guide/query-limits.md`.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-097 — Design for the Free plan's limits, not its tolerance.
- L-114 — Declared costs cover the worst case.

## Docs to update
- docs/guide/cloudflare-limits.md
- docs/guide/query-limits.md

## Out of scope
- Anything not listed under Scope.
