---
id: P4-09
title: Admin security review (owner boundaries on every writer)
phase: 4
status: todo
priority: high
depends_on: [P4-04, P4-05, P4-06, P4-07]
adr: ["0008"]
lessons: [L-065, L-091, L-093]
owner: ""
---

# P4-09 — Admin security review (owner boundaries on every writer)

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Make sure no path lets an admin or member widen access beyond what owners allow.

## Scope
- Review every writer of credentials, defaults, Agility projects, tools and write settings (API, CLI, panel, import); redirects; sessions; findings fixed with regression tests.

## Acceptance criteria
- [ ] `docs/reviews/phase-4-admin-security-review.md`; every finding fixed or accepted with a reason.

## Security notes
THREAT_MODEL T3, T13, T14, A5.

## Lessons applied
- L-065 — Every alternate writer is an authorization boundary.
- L-091 — Validate redirect targets after parsing.
- L-093 — Re-authenticate before high-impact actions.

## Docs to update
- docs/reviews/phase-4-admin-security-review.md (new)

## Out of scope
- Anything not listed under Scope.
