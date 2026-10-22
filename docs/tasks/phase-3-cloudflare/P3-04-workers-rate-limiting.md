---
id: P3-04
title: Rate limiting on Workers
phase: 3
status: review
priority: medium
depends_on: [P3-01]
adr: ["0010"]
lessons: [L-080, L-081, L-099]
owner: ""
---

# P3-04 — Rate limiting on Workers

> Refined 2026-10-22 (tasks/README rule 7).

## Goal
Edge rate limits that behave predictably across isolates.

## Scope
- The Worker keeps the exact per-isolate token buckets of `serve` (`MemoryRateLimiter`) and adds Cloudflare's Rate
  Limiting binding as a **backstop** for the two limits that matter across isolates (L-081, L-099):
  - `RL_IP`: requests per client address before authentication (T20);
  - `RL_AUTH`: failed authentications per address (T1). When the binding refuses a failure, this isolate marks the
    address as out of failed attempts for the binding's period, so its next failed attempts get `429` without another
    upstream validation (P2-17 F2), while valid tokens keep working.
  The local buckets decide first; the binding is consulted only when they allow.
- Policy, decided and tested (L-080): a binding that is **missing** means per-isolate limits only, with a warning at
  boot; a binding that **throws** lets the request through and logs once per minute (rate limits fail open, as on Node;
  authorization never depends on them).
- `wrangler.jsonc` declares both bindings with their limits (`RL_IP` 600 per 60 s, `RL_AUTH` 20 per 60 s); the setup
  script (P3-05) keeps them.
- A shared exact limiter (Durable Object) is **not** in this task: the binding's eventual consistency is the accepted
  residual risk for now, recorded in the threat model; a follow-up task holds the Durable Object option (P3-12).

## Acceptance criteria
- [x] Unit tests of the composite limiter: local first, binding as backstop, the auth-failure mark, missing and
      throwing bindings (fail open, logged).
- [x] workerd tests with Miniflare's rate-limit bindings: the binding refuses → `429`; failed authentications beyond
      `RL_AUTH` → `429` while a valid token still works.
- [x] `docs/guide/cloudflare-limits.md` (rate limits) and THREAT_MODEL T1/T20 updated; follow-up task for the Durable
      Object limiter.

## Security notes
THREAT_MODEL T1, T20.

## Lessons applied
- L-080 — Decide fail-open vs fail-closed for each control, and test it.
- L-081 — Per-process limits are not deployment-wide.
- L-099 — The Rate Limiting binding is a backstop.

## Docs to update
- docs/guide/cloudflare-limits.md

## Out of scope
- The Durable Object limiter (follow-up task); write limits (Phase 7).
