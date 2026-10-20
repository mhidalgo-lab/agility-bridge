---
id: P0-14
title: Owner decision gate for Phase 0
phase: 0
status: done
priority: high
depends_on: []
adr: ["0001"]
lessons: [L-009]
owner: "Matias Hidalgo"
---

# P0-14 — Owner decision gate for Phase 0

## Goal
Answer the few owner decisions that shape the first Phase 0 tasks before those tasks start, so nothing has to be redone.

## Scope
- Owner answers D-01 (sandbox access), D-02 (package, registry and domain names), D-05 (default tool groups), D-15 (Node versions) and D-19 (vocabulary) in docs/pending-decisions/phase-0.md.
- Owner answers D-10 – D-12 (write approval) or explicitly defers them to P0-13; ADR-0013's approval details stay `proposed` until then.
- Owner applies the repository settings needed for CI (see the owner checklist).

## Acceptance criteria
- [x] The five gate decisions are answered with a date; the rest are listed with a target task.
- [x] P0-01, P0-11 and P0-12 reference the answers they depend on.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-009 — Settle the expensive-to-retrofit decisions in Phase 0.

## Docs to update
- docs/pending-decisions/phase-0.md
- docs/ROADMAP.md (decision log)

## Out of scope
- Decisions that only P0-13 can take with spike evidence
