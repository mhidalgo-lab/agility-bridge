---
id: P2-05
title: Device access tokens
phase: 2
status: todo
priority: high
depends_on: [P2-04]
adr: ["0009"]
lessons: [L-066, L-067]
owner: ""
---

# P2-05 — Device access tokens

## Goal
One revocable token per device, bound to one workspace.

## Scope
- Format `ab_live_<43 base62>_<6 base62 CRC-32>` (`ab_test_…` on non-production deployments); checksum checked before any storage read.
- SHA-256 at rest, constant-time comparison, expiry (default 90 days, `never` allowed with a warning), `last_used_at` written at most every 5 minutes.
- Shown once; display prefix for lists.

## Acceptance criteria
- [ ] Format, checksum, expiry, revocation and wrong-workspace tests.
- [ ] gitleaks rule from P0-04 detects generated tokens.

## Security notes
THREAT_MODEL T1, T2.

## Lessons applied
- L-066 — Device tokens are random, typed, hashed and shown once.
- L-067 — Bind each token to one workspace.

## Docs to update
- docs/guide/access-model.md

## Out of scope
- Anything not listed under Scope.
