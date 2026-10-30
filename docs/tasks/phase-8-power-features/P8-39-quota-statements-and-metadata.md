---
id: P8-39
title: "Quota: one statement per request, and metadata requests"
phase: 8
status: done
priority: low
depends_on: [P8-09]
adr: ["0010"]
lessons: [L-115, L-415]
owner: ""
---

# P8-39 — Quota: one statement per request, and metadata requests

> Filed by the Phase 8 review ([P8-12](P8-12-phase-8-review.md), `docs/reviews/phase-8-review.md`).

## Goal
Reduce the quota's D1 cost and make drain independent of isolate recycling (review P-7 and Q-10).

## Scope
- When both periods are set, read and increment both counters in one statement or batch (one round trip, fewer rows), keeping the atomic capped increment semantics.
- Decide with the owner whether metadata requests (`meta.v1`, one to three per cold call, a dozen on a cold isolate) count: exclude them, or count them as one unit per request. A cold isolate must not drain a small quota faster than the caller's own use.
- Add the missing quota test for the metadata case.

## Acceptance criteria
- [x] One read and one write statement per request for two periods (counted in a test).
- [x] The owner's decision on metadata is recorded and tested.
- [x] `docs/guide/query-limits.md` and `docs/guide/cloudflare-limits.md` state the new numbers.

## Security notes
THREAT_MODEL T5, A10.

## Lessons applied
- L-115
- L-415

## Docs to update
- docs/guide/query-limits.md, docs/guide/cloudflare-limits.md

## Out of scope
- Per-grant overrides (P8-14).
