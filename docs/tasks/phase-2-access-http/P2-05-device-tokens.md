---
id: P2-05
title: Device access tokens
phase: 2
status: review
priority: high
depends_on: [P2-04]
adr: ["0009"]
lessons: [L-066, L-067]
owner: "Matias Hidalgo"
---

# P2-05 — Device access tokens

## Goal
One revocable token per device, bound to one workspace.

## Scope
- Format `ab_live_<43 base62>_<6 base62 CRC-32>` (`ab_test_…` on non-production deployments); checksum checked before any storage read.
- SHA-256 at rest, constant-time comparison, expiry (default 90 days, `never` allowed with a warning), `last_used_at` written at most every 5 minutes.
- Shown once; display prefix for lists.

## Acceptance criteria
- [x] Format, checksum, expiry, revocation and wrong-workspace tests. *(`packages/auth/test/tokens.test.ts`; a malformed
  token causes no storage read, and the audience is checked before revocation.)*
- [x] gitleaks rule from P0-04 detects generated tokens. *(`scripts/test/device-token-rule.test.ts` compiles the rule
  from `.gitleaks.toml` and runs it, and the log redaction, on 100 generated tokens.)*

## Notes
- `packages/auth/src/tokens/device.ts`: `generateDeviceToken`, `isWellFormedDeviceToken` (offline format and CRC-32
  checksum), `hashDeviceToken`, `bearerToken`, `authenticateDeviceToken` (format → hash lookup + constant-time compare →
  `resolveAccess` → `touch` every 5 minutes). `accessServices().tokens.issue/revoke/list`.
- The `access_tokens.prefix` column now holds the display prefix (`ab_live_Xy12`); migration 0001 is not released yet,
  so its CHECK changed in place together with the frozen checksum and the 0.2 fixture.

## Security notes
THREAT_MODEL T1, T2.

## Lessons applied
- L-066 — Device tokens are random, typed, hashed and shown once.
- L-067 — Bind each token to one workspace.

## Docs to update
- [x] docs/guide/access-model.md

## Out of scope
- Anything not listed under Scope.
