---
id: P9-16
title: Worst-case fixtures with paging for the report composites
phase: 9
status: todo
priority: medium
depends_on: [P9-03]
adr: ["0010"]
lessons: [L-114, L-115]
owner: ""
---

# P9-16 — Worst-case fixtures with paging for the report composites

> Filed by [P9-03](P9-03-performance-cost.md) (`docs/reference/performance.md`).

## Goal
`sprint_health` (declared 54) and `standup_summary` (48) are hidden on the Free budget of 45 but measured 23 and 21 requests cold (P9-03, D-357). Prove the real worst case, and lower the declared cost or explain it.

## Scope
- Extend `worst-case.ts` for the two reports with a world that pages every section to its cap (rows above one page, many sprints, every asset type touched), and measure.
- If the bound is at most 45 and holds with the sections at their caps, lower the declared cost (a decision, the Free budget decides which tools are offered); otherwise record the proof of why it is higher.
- Also look at `standup_summary`, whose warm CPU on a Worker is 31 ms (about three times any other tool): where does it go.

## Acceptance criteria
- [ ] The worst-case fixture of both reports pages every section to its cap and the cost test asserts the declared cost against it.
- [ ] The declared cost is lowered with a recorded decision, or the reason it stays is in the task and the guide.
- [ ] The CPU of `standup_summary` is explained or reduced.

## Security notes
None beyond the shared rules in AGENTS.md.

## Docs to update
- docs/guide/cloudflare-limits.md, docs/reference/performance.md
