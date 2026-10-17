---
id: P2-04
title: Access model and effective-permission resolver
phase: 2
status: todo
priority: high
depends_on: [P2-01, P2-03]
adr: ["0008"]
lessons: [L-062, L-063, L-065, L-069, L-152]
owner: ""
---

# P2-04 — Access model and effective-permission resolver

## Goal
One pure function decides what a request may do, denying by default.

## Scope
- Domain services for instances, credentials (personal or shared), workspaces, grants.
- `resolveAccess(token or OAuth props, slug)` implementing the effective-permission rules of ADR-0008: tools, Agility projects, asset types, credential, limits.
- Rules: shared credentials only for read-only grants; write tools only when the credential is the grant user's own; a grant may use only the workspace default (shared), a shared credential or its own user's personal credential.
- Warnings when requested scope exceeds what is effective.

## Acceptance criteria
- [ ] Property tests: the effective set never exceeds any of its inputs; every missing, disabled, revoked, expired, unvalidated or malformed input denies.
- [ ] Tests for the token policy (no writes with shared credentials; no use of another user's personal credential).

## Security notes
THREAT_MODEL T3, A5, A6.

## Lessons applied
- L-062 — Limits live on the workspace and can only be tightened by a grant.
- L-063 — Effective permissions are intersections, resolved once and rechecked.
- L-065 — Every alternate writer is an authorization boundary.
- L-069 — Prefer bring-your-own-token.
- L-152 — One identity per tool call.

## Docs to update
- docs/ARCHITECTURE.md §4
- docs/guide/access-model.md (new)

## Out of scope
- Anything not listed under Scope.
