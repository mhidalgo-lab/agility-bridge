---
id: P9-15
title: Cut the fixed per-request CPU on Workers
phase: 9
status: todo
priority: medium
depends_on: [P9-03]
adr: ["0010"]
lessons: [L-097, L-491]
owner: ""
---

# P9-15 — Cut the fixed per-request CPU on Workers

> Filed by [P9-03](P9-03-performance-cost.md) (`docs/reference/performance.md`).

## Goal
Warm calls cost 6 to 9 ms of CPU on a Free Worker before the tool does any work (P9-03: 33% of warm calls above the 10 ms limit, none refused). Find where it goes and cut it.

## Scope
- Profile a warm `whoami` and `list_teams` on workerd (the CPU profile of `wrangler dev --inspector`, or the bench in workerd): bearer verification, access resolution, audit write, JSON-RPC, shaping, response.
- Cut what can be cut without changing behaviour or weakening a check (cache the verified-token lookup per isolate, avoid a second JSON parse, move work after the response with `waitUntil`).
- Re-measure with `scripts/perf/latency.ts remote` and `scripts/perf/tail-cpu.ts`; update the performance reference.

## Acceptance criteria
- [ ] The p50 of `whoami` and `list_teams` on a deployed Free Worker is below 5 ms, or the profile shows why it cannot be (recorded in RESEARCH).
- [ ] No security check is removed (negative authorization tests unchanged and green).
- [ ] `docs/reference/performance.md` regenerated from a new run.

## Security notes
None beyond the shared rules in AGENTS.md.

## Docs to update
- docs/guide/cloudflare-limits.md, docs/reference/performance.md
