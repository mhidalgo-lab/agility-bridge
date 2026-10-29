---
id: P7-31
title: "Bench the approval page and the write limiter; take the outcome audit off the hot path"
phase: 7
status: done
priority: low
depends_on: [P7-09]
adr: ["0013"]
lessons: [L-408]
owner: ""
---

# P7-31 — Bench the approval page and the write limiter; take the outcome audit off the hot path

> Filed by P7-09 (performance review). Refined 2026-10-29 (lane A).

## Goal
`pnpm bench:worker` now measures a write tool (dry run, approved write, the two calls of the page flow). The approval page
itself, the write limiter and the audit rows are still unmeasured, and the outcome audit row is awaited before the answer.

## Scope
- **Bench rows** in `pnpm bench:worker` (CPU and storage operations): the approval page view (`GET /admin/approve/:id`), the
  pending list, the decision POST (approve) in the panel world, and a write with the real deployment limiter over counted
  counters (a D1-shaped store: one read and two increments per write). The baseline gets the new rows only; the existing
  ones are not rewritten (a loaded machine would move them).
- **Outcome audit.** The bench measures CPU, and moving the outcome row to `waitUntil` changes wall-clock latency (one insert),
  not CPU. The decision is made on the durability argument (D-212): the outcome stays awaited. The intent stays awaited and
  first either way (ADR-0013), a failed outcome row is logged, never thrown (already tested), and the viewer flags an intent
  with no outcome (P7-11). If staging measurements (P7-10) show the insert as a real share of a write's latency, the move is
  a small change behind the same sink.
- The next request saving from `close_asset` and `create_work_item` logs is left to P7-10 (it needs a real instance).

## Acceptance criteria
- [x] The benchmark has rows for the page view, the list, the decision and a limited write. The baseline entries come from
      this run (a developer machine; CI's own comparison is relative to its calibration, and the CI artifact is the history).
- [x] The outcome-audit decision is recorded (D-212); nothing moves, so no new audit test is needed, and the existing ones
      (intent before send, failed outcome logged not thrown) stay.

## Security notes
THREAT_MODEL A6 (audit), T17.

## Lessons applied
- L-408 — count storage operations per path.

## Docs to update
- docs/guide/cloudflare-limits.md

## Out of scope
- Changing the audit model (three rows per write).
