---
id: P3-12
title: Optional exact rate limiter on a Durable Object
phase: 3
status: review
priority: low
depends_on: [P3-04]
adr: ["0010"]
lessons: [L-080, L-081, L-099]
owner: ""
---

# P3-12 — Optional exact rate limiter on a Durable Object

> Refined 2026-11-03: the object decides `authfail:`, `signin:` and `oauth:` request keys and the write counters (D-339); on failure
> request limits fall back to the binding and per-isolate buckets, write counters refuse the write (D-340). The Durable Object is a
> `fetch`-based class exported by the Worker; the binding and migration are added by the operator (not declared by default).

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
- [x] workerd tests: an exact limit across two isolates (two Miniflare workers sharing the object); failure policy
      tested (`apps/worker/test/shared-limiter-workerd.test.ts`, `shared-limiter.test.ts`).
- [x] THREAT_MODEL T1/T20 residual risk updated when enabled (8e-3), with the write counters (T31).
- [x] Cost note and the opt-in `wrangler.jsonc` snippet in `docs/guide/cloudflare-limits.md`.
- [ ] *owner / live:* the object deployed on the staging Worker and measured there (billed requests per flow, latency from a
  distant location); see P3-16. No Cloudflare account is available to the agent.

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
