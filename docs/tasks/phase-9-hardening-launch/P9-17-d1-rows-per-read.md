---
id: P9-17
title: D1 rows written per read call
phase: 9
status: todo
priority: medium
depends_on: [P9-03]
adr: ["0010"]
lessons: [L-097, L-492]
owner: ""
---

# P9-17 — D1 rows written per read call

> Filed by [P9-03](P9-03-performance-cost.md) (`docs/reference/performance.md`).

## Goal
A read tool call writes about 4 D1 rows (P9-03 measured), which caps a read-only Free deployment at about 24,000 calls a day (D-359). Attribute the rows and reduce them if it is safe.

## Scope
- Read `meta.rows_written` or the analytics per statement for one call and attribute the 4 rows (audit row and its indexes, token last-used, others).
- Options to weigh in a decision: drop an index of `audit_log` that no query needs, widen the token last-used interval, batch read audit rows per isolate and write them after the response, or sample.
- Keep the guarantees: every call still leaves an audit row that the usage statistics read, and a denial is always audited.

## Acceptance criteria
- [ ] The rows per read call are attributed in the guide (measured, not computed).
- [ ] A reduction is built, or a decision records why not.
- [ ] The Free ceiling in `docs/guide/cloudflare-limits.md` is updated.

## Security notes
None beyond the shared rules in AGENTS.md.

## Docs to update
- docs/guide/cloudflare-limits.md, docs/reference/performance.md
