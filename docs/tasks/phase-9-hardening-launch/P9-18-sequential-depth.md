---
id: P9-18
title: Shorten the longest request chains of the slowest tools
phase: 9
status: todo
priority: low
depends_on: [P9-03]
adr: ["0010"]
lessons: [L-114]
owner: ""
---

# P9-18 — Shorten the longest request chains of the slowest tools

> Filed by [P9-03](P9-03-performance-cost.md) (`docs/reference/performance.md`).

## Goal
Latency is the longest chain of Agility requests times the upstream latency (P9-03): `get_portfolio_tree` and `release_readiness` 4 requests in sequence, `search_work_items` 4 including a `ChangeDate` sort. Batch or parallelise independent reads.

## Scope
- For the five slowest tools (`get_portfolio_tree`, `release_readiness`, `search_work_items`, `list_portfolio_items`, `list_recent_changes`) draw the request graph from the fakes and mark the requests that do not depend on each other.
- Send independent queries in one `query.v1` array (the endpoint takes one) or in parallel (at most 6 on Workers), keeping the budget count per request.
- Check the cost test and the baseline: requests must not grow; the chain should shrink.

## Acceptance criteria
- [ ] The request graph of each of the five tools is in the task or the guide.
- [ ] The chain is shorter for at least three of them with the same results (consistency tests unchanged).
- [ ] The latency model run shows the change (`pnpm bench:latency`).

## Security notes
None beyond the shared rules in AGENTS.md.

## Docs to update
- docs/guide/cloudflare-limits.md, docs/reference/performance.md
