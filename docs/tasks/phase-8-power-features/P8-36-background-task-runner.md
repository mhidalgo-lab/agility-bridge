---
id: P8-36
title: Run MCP Tasks outside the poll
phase: 8
status: todo
priority: low
depends_on: [P8-10, P8-15]
adr: ["0005"]
lessons: [L-416, L-451]
owner: ""
---

# P8-36 — Run MCP Tasks outside the poll

> Filed by the Phase 8 review ([P8-12](P8-12-phase-8-review.md), `docs/reviews/phase-8-review.md`).

## Goal
Let a task run to the end even when the client drops the poll that started it (review Q-2 residual), so a long report is never run twice.

## Scope
- Decide, with the owner, between a Durable Object, a Queue consumer and `waitUntil` for reports that fit its budget; the first two need Cloudflare resources beyond the staging Worker and D1, so the choice and the resources are the owner's.
- Whatever runs the report uses the same pipeline (access re-resolved, budget, quota, audit) and writes the sealed result the polls read; a poll only reads.
- Keep the kill switch (`AB_TASKS=off`) and the Node host's behaviour.

## Acceptance criteria
- [ ] The owner decides the runner and creates the resources (not done by an agent).
- [ ] A test shows a dropped poll does not lead to a second run.
- [ ] The docs lose the "abandoned poll" paragraph.

## Security notes
THREAT_MODEL T32: a runner has the same authorisation checks as a poll.

## Lessons applied
- L-416
- L-451

## Docs to update
- docs/guide/tasks.md, docs/guide/cloudflare-limits.md

## Out of scope
- Changing what reports do.
