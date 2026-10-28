---
id: P6-15
title: Server-side aggregate roll-ups for the portfolio tree
phase: 6
status: done
priority: low
depends_on: [P6-01]
adr: ["0012"]
lessons: [L-143, L-148, L-272]
owner: ""
---

# P6-15 — Server-side aggregate roll-ups for the portfolio tree

> Closed as **not supported** (2026-10-28, D-143): the aggregate forms are accepted live but do not equal the rows read, so
> `get_portfolio_tree` keeps the computed roll-ups. Evidence: RESEARCH, `live/portfolio-aggregates.live.test.ts`.

## Goal
Make the portfolio roll-ups exact and cheap on large epics by asking Agility to aggregate, instead of reading up to three
pages of backlog items per type ([D-80](../../pending-decisions/phase-6.md)).

## Scope
- Verify live (guarded suite) whether `Subs:Story[...]`/`Subs:Defect[...]` aggregations with `@Count` and `@Sum` on
  `Estimate` work on this version, with the dead-asset bracket filter, and with a status or state condition for done and
  open defects. Record the result in RESEARCH §1 as verified or not.
- If they do: a metadata-checked aggregate form in the compiler (downcast, one relation, one condition), used by
  `get_portfolio_tree` per epic in one batched request, with the current read-the-rows path kept as the fallback.

## Acceptance criteria
- [x] RESEARCH records what was verified, with date and instance version (shapes only).
- [x] (Not used: the aggregate does not match the rows, so nothing changes.) If used: roll-ups equal the read-the-rows result on the synthetic fixtures; cost lower or equal; the 300-item
      cap and its `incomplete` marking go away only where the aggregate is exact.

## Security notes
THREAT_MODEL T4 (no strings built into queries) and A4 (aggregates cross relations: the scope guards must hold).

## Lessons applied
- L-143 — Aggregations include dead assets unless filtered.
- L-148 — Verify relations live.
- L-272 — A roll-up that cannot be exact says so.

## Docs to update
- docs/RESEARCH.md, docs/reference/tool-catalogue.md, docs/reference/tools.md (generated).

## Out of scope
- Other roll-up dimensions (by team, by sprint).
