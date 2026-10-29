---
id: P7-30
title: "Free-plan ceiling for the deployment write cap; one statement for the grant and denial take"
phase: 7
status: todo
priority: low
depends_on: [P7-03, P7-02]
adr: ["0013"]
lessons: [L-408]
owner: ""
---

# P7-30 — Free-plan ceiling for the deployment write cap; one statement for the grant and denial take

> Filed by P7-09 (performance review, D-199, D-200). Refine scope and acceptance criteria before starting.

## Goal
On D1, one approved write by the approval page costs about 30 rows written, and the default deployment cap
(`AB_WRITE_RATE_DEPLOYMENT_HOURLY`, 200 an hour) can exceed the Free plan's 100,000 rows a day if sustained
([cloudflare-limits](../../guide/cloudflare-limits.md#write-tools-and-the-d1-row-budget)). Make the Free plan safe by
default and take two more round trips out of the page flow.

## Scope
- With `AB_PLAN=free`, treat the deployment write cap as a ceiling like the other Free ceilings (a value above it stops the
  Worker at its first request, or is capped and shown in `whoami`); choose the number from the verified row accounting.
- One storage statement for the grant and denial take (`DELETE ... WHERE key IN (?, ?) RETURNING`) behind a `KvStore`
  method with memory, SQLite and D1 adapters and a shared contract test; single use, binding and fail closed unchanged.
- Verify the row accounting on the staging Worker (the index writes are *unverified*, D-200) and correct the guide.

## Acceptance criteria
- [ ] The Free default cannot exceed the daily row limit by write traffic alone; a test shows the ceiling.
- [ ] The take of a grant or denial is one statement; the contract test covers single use and concurrent takers.
- [ ] The guide's row table is checked against the D1 `meta.rows_written` of a staging write, or still marked unverified.

## Security notes
THREAT_MODEL T31 (single use of approvals), A2.

## Lessons applied
- L-408 — count storage operations per path, not only requests.

## Docs to update
- docs/guide/cloudflare-limits.md, docs/guide/write-tools.md, docs/guide/configuration.md

## Out of scope
- Batching the two limiter counters (the order is deliberate: a caller over its own limit must not spend the deployment's budget).
