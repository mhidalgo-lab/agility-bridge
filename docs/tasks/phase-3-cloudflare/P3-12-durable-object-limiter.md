---
id: P3-12
title: Optional exact rate limiter on a Durable Object
phase: 3
status: todo
priority: low
depends_on: [P3-04]
adr: ["0010"]
lessons: [L-080, L-081, L-099]
owner: ""
---

# P3-12 — Optional exact rate limiter on a Durable Object

## Goal
A deployment-wide, exact limit for failed authentications (and later sign-in and writes) on Workers, for deployments
that need more than the Rate Limiting binding's per-location, eventually consistent backstop (P3-04).

## Scope
- A Durable Object implementing `RateLimiter` (`take`, `peek`) with token buckets keyed by limit key, one object per
  key shard; opt-in through a `RL_SHARED` binding; the binding backstop stays the default.
- Policy: failures of the Durable Object fail open for request limits (logged), and fail closed for write limits when
  Phase 7 uses it (ADR-0013).
- Cost note in `docs/guide/cloudflare-limits.md` (each call is a billed Durable Object request).

## Acceptance criteria
- [ ] workerd tests: an exact limit across two isolates (two Miniflare workers sharing the object); failure policy
      tested.
- [ ] THREAT_MODEL T1/T20 residual risk updated when enabled.

## Security notes
THREAT_MODEL T1, T20 (residual risk of P3-04).

## Lessons applied
- L-080 — Decide fail-open vs fail-closed for each control, and test it.
- L-081 — Per-process limits are not deployment-wide.
- L-099 — The Rate Limiting binding is a backstop.

## Docs to update
- docs/guide/cloudflare-limits.md

## Out of scope
- Making it the default; sign-in limits (Phase 4) beyond the interface.
