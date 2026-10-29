---
id: P7-10
title: Write pipeline on staging Workers
phase: 7
status: todo
priority: medium
depends_on: [P7-01]
adr: ["0013"]
lessons: [L-073, L-081, L-384]
owner: ""
---

# P7-10 — Write pipeline on staging Workers

> Filed by P7-01 ([write framework](P7-01-write-framework.md)). Refine scope and acceptance criteria before starting.

## Goal
The approval ledger and the sealed round-trip state hold across isolates on Cloudflare (D1-backed `kv`, per-isolate master-key derivation).

## Scope
- On the staging Worker (agility-bridge-staging, with the owner's go) run a test-only write tool behind a fake upstream: concurrent `take` of one round entry from several isolates hands it out once; state issued by one isolate verifies in another; an intent-audit write that fails in D1 refuses the write.
- Measure CPU of a write call (plan, approval round, re-read, two audit rows) against the Worker budget; record it in RESEARCH.

## Acceptance criteria
- [ ] Concurrency run: one winner among N parallel retries of the same approved round.
- [ ] Cross-isolate state verification and an expired or forged state refused, on staging.
- [ ] Audit outage on D1 refuses the write; nothing sent.
- [ ] CPU and request counts recorded.

## Security notes
THREAT_MODEL T31, T21.

## Lessons applied
- L-073 — One-time state is consumed atomically.
- L-081 — Per-process limits are not deployment-wide.
- L-384 — An approval answer counts only with the sealed, single-use state of its question.

## Docs to update
- docs/guide/write-tools.md
- docs/RESEARCH.md

## Out of scope
- Anything not listed under Scope.
