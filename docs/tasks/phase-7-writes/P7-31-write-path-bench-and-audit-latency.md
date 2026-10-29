---
id: P7-31
title: "Bench the approval page and the write limiter; take the outcome audit off the hot path"
phase: 7
status: todo
priority: low
depends_on: [P7-09]
adr: ["0013"]
lessons: [L-408]
owner: ""
---

# P7-31 — Bench the approval page and the write limiter; take the outcome audit off the hot path

> Filed by P7-09 (performance review). Refine scope and acceptance criteria before starting.

## Goal
`pnpm bench:worker` now measures a write tool (dry run, approved write, the two calls of the page flow). The approval page
itself, the write limiter and the audit rows are still unmeasured, and the outcome audit row is awaited before the answer.

## Scope
- Bench `GET /admin/approve/:id` and the decide POST in the panel world, and a write with the deployment limiter on a D1-shaped fake.
- Decide whether the outcome audit row may go through the app's background (`waitUntil`) as the `tool_call` row does; the
  intent row stays awaited and first (ADR-0013). Record the durability trade-off as a decision.
- Child counts of `close_asset` and the caller lookup of `create_work_item` are already one request (P7-09); look for the
  next request saving from the measured logs only if the budget needs it.

## Acceptance criteria
- [ ] The benchmark has rows for the page view, the decision and a limited write, with baselines from CI.
- [ ] The outcome-audit decision is recorded; if it moves, a test shows the intent is stored before the send and a failed outcome row is logged, not thrown.

## Security notes
THREAT_MODEL A6 (audit), T17.

## Lessons applied
- L-408 — count storage operations per path.

## Docs to update
- docs/guide/cloudflare-limits.md

## Out of scope
- Changing the audit model (three rows per write).
