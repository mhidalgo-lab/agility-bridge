---
id: P9-05
title: Support, versioning and deprecation policy
phase: 9
status: todo
priority: medium
depends_on: [P8-12]
adr: []
lessons: [L-027, L-045]
owner: ""
---

# P9-05 — Support, versioning and deprecation policy

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Users know what is supported, for how long, and how changes are announced.

## Scope
- Semantic versioning; supported Node, Agility (hosted and minimum on-premises version) and client versions; deprecation window (at least one minor and six months); security fix policy; upgrade notes (reconnect clients after upgrades).

## Acceptance criteria
- [ ] Policy published and linked from SECURITY.md and the README.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-027 — Clients cache tool lists.
- L-045 — Deprecate on purpose.

## Docs to update
- docs/guide/versioning.md (new)
- docs/guide/upgrading.md (new)

## Out of scope
- Anything not listed under Scope.
