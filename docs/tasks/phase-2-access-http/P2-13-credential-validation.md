---
id: P2-13
title: Agility credential validation
phase: 2
status: todo
priority: medium
depends_on: [P2-03, P2-04]
adr: ["0008", "0014"]
lessons: [L-054, L-140, L-147]
owner: ""
---

# P2-13 — Agility credential validation

## Goal
Know whose token a credential is, what it can reach, and when it stops working.

## Scope
- Validate on save and on demand: member id, name, username, reachable Agility projects; status `valid`/`invalid` with a safe error code.
- Periodic revalidation (configurable) and on repeated `AB_AGILITY_AUTH` errors.
- Clear messages for wrong instance URL vs revoked token.
- A new or changed instance origin is probed with an unauthenticated `meta.v1` request before any token is sent to it.

## Acceptance criteria
- [ ] Tests for valid, revoked, wrong-instance and redirecting instances.
- [ ] Credential hint shows only the last 4 characters.

## Security notes
THREAT_MODEL A5, A9, A14.

## Lessons applied
- L-054 — The instance is first-class configuration.
- L-140 — A 404 means "not found or not visible".
- L-147 — Access tokens are full delegation and never expire.

## Docs to update
- docs/guide/access-model.md

## Out of scope
- Anything not listed under Scope.
