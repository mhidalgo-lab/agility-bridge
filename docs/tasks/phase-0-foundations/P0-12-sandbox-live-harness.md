---
id: P0-12
title: Agility sandbox and live-verification harness
phase: 0
status: todo
priority: high
depends_on: [P0-03, P0-14]
adr: ["0011"]
lessons: [L-003, L-122, L-125]
owner: ""
---

# P0-12 — Agility sandbox and live-verification harness

## Goal
A safe Agility sandbox, a protected way to run live tests and a template for evidence, before any spike or tool depends on real behaviour.

## Scope
- Owner obtains a hosted sandbox instance (and, if possible, an on-premises test instance).
- Two least-privilege members (reader, writer) with personal access tokens.
- Seed plan: parent/child Agility projects, teams with their own workflows, sprints, members, backlog items, defects, tasks, tests, epics with categories (Feature, Initiative), issues, requests, regression tests/plans/suites, test sets, custom fields, conversations, attachments.
- GitHub `live` environment restricted to `main`, with required reviewers and `AB_LIVE_*` secrets.
- Live-suite skeleton (`vitest.live.config`): read-only, never on fork PRs, never prints tokens.
- `docs/dev/verification.md`: evidence template (date, instance version, workspace, asset numbers, expected vs actual, redactions) and the fixture-sanitisation checklist.

## Acceptance criteria
- [ ] Both members' tokens validated against the sandbox.
- [ ] Seed data created and documented with asset numbers.
- [ ] The live workflow runs a trivial read-only probe from `main`.
- [ ] Template and checklist committed.

## Security notes
Tokens only as environment secrets; synthetic seed data (THREAT_MODEL T8, A5).

## Lessons applied
- L-003 — Plan live verification from Phase 0, not at the end.
- L-122 — Feed tools hostile upstream data.
- L-125 — Keep live-verification evidence and recipes.

## Docs to update
- docs/dev/verification.md (new)
- docs/pending-decisions/phase-0.md (sandbox access)

## Out of scope
- The full live suite (P1-12)
