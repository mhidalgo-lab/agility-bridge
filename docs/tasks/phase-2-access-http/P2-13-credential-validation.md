---
id: P2-13
title: Agility credential validation
phase: 2
status: done
priority: medium
depends_on: [P2-03, P2-04]
adr: ["0008", "0014"]
lessons: [L-054, L-140, L-147]
owner: "Matias Hidalgo"
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
- [x] Tests for valid, revoked, wrong-instance and redirecting instances. *(`packages/auth/test/validate.test.ts`, plus
  outages, the probe's refusals, probe-before-retarget, revalidation; the CLI equivalence test validates against the
  synthetic Agility.)*
- [x] Credential hint shows only the last 4 characters.

## Notes
- `packages/auth/src/access/validate.ts`: `validateAgilityToken` (member via `IsSelf`, reachable projects ≤ 1,000,
  safe codes and messages), `probeInstance` (unauthenticated `meta.v1/Member`, no redirects, JSON with `Token`; records
  the `ETag` fingerprint), `UpstreamCheckError` (admin API 502).
- Services validate on create/replace, on demand (`credentials.validate`, admin route and `credential validate`) and
  `revalidate(olderThan)`; instances are probed before create and retarget. `serve` revalidates every
  `AB_CREDENTIAL_REVALIDATION_HOURS` and after 3 consecutive `AB_AGILITY_AUTH` errors (≤ once per 10 min).
- `scripts/fixture-agility.ts` exports `startFixtureAgility` for in-process tests.

## Security notes
THREAT_MODEL A5, A9, A14.

## Lessons applied
- L-054 — The instance is first-class configuration.
- L-140 — A 404 means "not found or not visible".
- L-147 — Access tokens are full delegation and never expire.

## Docs to update
- [x] docs/guide/access-model.md

## Out of scope
- Anything not listed under Scope.
