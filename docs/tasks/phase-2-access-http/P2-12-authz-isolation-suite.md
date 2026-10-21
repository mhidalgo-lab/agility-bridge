---
id: P2-12
title: Authorization and isolation test suite
phase: 2
status: done
priority: high
depends_on: [P2-06]
adr: ["0008"]
lessons: [L-013, L-059, L-064, L-121, L-145]
owner: "Matias Hidalgo"
---

# P2-12 — Authorization and isolation test suite

## Goal
Prove, for every route, principal and tool, that denials deny and that workspaces never see each other's data.

## Scope
- Matrix: route × principal (none, bad token, other workspace, revoked, expired, member, admin, owner) × tool.
- Assertions: exact status, audit reason, **zero Agility requests**, zero mutations, no foreign data.
- Hostile upstream: rows from other Agility projects, forged numbers, single-asset requests outside scope.
- One case per scope-strategy class (direct, derived, workspace-bounded, global, denied) for `query_assets` and `get_assets`.
- Two-workspace concurrency test with different credentials.

## Acceptance criteria
- [x] Suite runs in CI on Node (and on workerd from P3-06). *(`packages/http-app/test/authz.test.ts`, part of
  `pnpm test`.)*
- [x] Each regression test fails when its fix is reverted (verified once per test in review). *(The one new fix —
  identity check in `get_assets`/`resolveAsset` — was reverted locally: the authz test and the new core test fail.
  The denial matrix and admin matrix were mutation-checked in P2-04, P2-06 and P2-09.)*

## Notes
- Matrix: 14 principals × (`initialize`, `tools/list`, every tool) → the same 401, the audit reason, zero Agility
  requests, zero mutations. Member/admin/owner roles are the admin-route matrix in `admin.test.ts` (P2-09).
- Found and fixed: with an upstream that ignores filters, `get_assets` and `resolveAsset` returned a different in-scope
  asset for a reference outside the workspace (L-174). Both now keep only rows with the requested identity.

## Security notes
THREAT_MODEL T3, T21, A4.

## Lessons applied
- L-013 — Never keep request data in module state.
- L-059 — Scope predicates cannot be widened.
- L-064 — Recheck results, not only requests.
- L-121 — Negative authorization is first-class.
- L-145 — Single-asset URLs ignore `where`.

## Docs to update
- [x] docs/dev/testing.md

## Out of scope
- Anything not listed under Scope.
