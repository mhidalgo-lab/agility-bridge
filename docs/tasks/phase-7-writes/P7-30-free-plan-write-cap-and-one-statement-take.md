---
id: P7-30
title: "Free-plan ceiling for the deployment write cap; one statement for the grant and denial take"
phase: 7
status: review
priority: low
depends_on: [P7-03, P7-02]
adr: ["0013"]
lessons: [L-408]
owner: ""
---

# P7-30 — Free-plan ceiling for the deployment write cap; one statement for the grant and denial take

> Filed by P7-09 (performance review, D-199, D-200). Refined 2026-10-29 (lane A).

## Goal
On D1, one approved write by the approval page costs about 30 rows written, and the default deployment cap
(`AB_WRITE_RATE_DEPLOYMENT_HOURLY`, 200 an hour) can exceed the Free plan's 100,000 rows a day if sustained
([cloudflare-limits](../../guide/cloudflare-limits.md#write-tools-and-the-d1-row-budget)). Make the Free plan safe by
default and take two more round trips out of the page flow.

## Scope
- **Free ceiling.** `AB_PLAN=free` has a deployment write cap of at most 60 an hour: unset it is 60 (the Paid and Node default
  stays 200), and an explicit `AB_WRITE_RATE_DEPLOYMENT_HOURLY` above 60 stops the Worker at its first request, like the
  call-budget and response-size ceilings. 60 an hour is 1,440 writes a day, about 45,000 D1 rows at 31 rows per
  page-approved write: under half of the 100,000 a day, the rest being for reads, OAuth counters and audit rows. The
  startup log line carries the effective value.
- **One statement for the grant and the denial.** Since P7-28 a grant is read before the limiter and used up just before the
  send, so a single `DELETE ... RETURNING` of both keys would consume a grant that a later refusal must keep. The built form
  is `KvStore.getMany(keys)`: one `SELECT ... WHERE key IN (...)` (memory, SQLite and D1 share the SQL adapter, plus the
  memory store, with a contract test) for the grant and the denial together; the entry acted on is then taken once, so single
  use, binding and fail closed are unchanged (D-210). Net statements for the page flow stay 18 (the first call saves one, the
  repeat costs one for the peek P7-28 added); both extra statements are reads.
- **Row accounting on the staging Worker** needs the write pipeline running there (P7-10) and the owner's sandbox for the
  Agility side; it cannot be done now. The guide keeps the table marked *unverified*; the item moves to P7-10.

## Acceptance criteria
- [x] The Free default cannot exceed the daily row limit by write traffic alone; a test shows the ceiling (plan preset test,
      worker boot refusal above 60, and the row arithmetic).
- [x] The grant and the denial are read with one statement (`getMany`); the contract test covers live, expired, absent and
      bounded keys, and the pipeline test counts statements on the page path.
- [ ] The guide's row table checked against `meta.rows_written` of a staging write (blocked on P7-10; stays *unverified*).

## Security notes
THREAT_MODEL T31 (single use of approvals), A2.

## Lessons applied
- L-408 — count storage operations per path, not only requests.

## Docs to update
- docs/guide/cloudflare-limits.md, docs/guide/write-tools.md, docs/guide/configuration.md

## Out of scope
- Batching the two limiter counters (the order is deliberate: a caller over its own limit must not spend the deployment's budget).
