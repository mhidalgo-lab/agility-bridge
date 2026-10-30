---
id: P8-38
title: Shared-tier size cap and Worker CPU of sealing
phase: 8
status: todo
priority: low
depends_on: [P8-13]
adr: ["0010"]
lessons: [L-414, L-448]
owner: ""
---

# P8-38 — Shared-tier size cap and Worker CPU of sealing

> Filed by the Phase 8 review ([P8-12](P8-12-phase-8-review.md), `docs/reviews/phase-8-review.md`).

## Goal
Settle the CPU cost of sealing and opening shared-tier entries on workerd (review P-1): the byte loop is fixed, but base64 and the extra JSON parses still cost milliseconds at 64 KB and more on a 10 ms Free budget.

## Scope
- Measure `Keyring.seal`/`open` and `toBase64` on workerd (not Node) for 8, 64 and 256 KB; prefer `Uint8Array.prototype.toBase64` where it exists.
- Decide a lower size cap for the shared tier than the memory tier's 256 KiB (for example 32 to 64 KiB) and implement it as an option of the tier, with the docs.
- Avoid the double JSON parse of a hit if the measurement says it matters.

## Acceptance criteria
- [ ] Measured numbers on workerd are in `docs/RESEARCH.md` with the date.
- [ ] The shared tier skips entries above its cap and `whoami` still tells the truth.
- [ ] A test pins the cap.

## Security notes
THREAT_MODEL T16.

## Lessons applied
- L-414
- L-448

## Docs to update
- docs/guide/query-cache.md, docs/RESEARCH.md

## Out of scope
- Changing the memory tier's limits.
