---
id: P2-07
title: Rate limiting (pluggable)
phase: 2
status: todo
priority: high
depends_on: [P2-06]
adr: ["0010"]
lessons: [L-079, L-080, L-081]
owner: ""
---

# P2-07 — Rate limiting (pluggable)

## Goal
Abuse controls per surface with an explicit fail-open/fail-closed policy.

## Scope
- Pluggable `RateLimiter`; bounded in-memory token buckets on Node.
- Per IP (default 600/min), authentication failures per IP (10 per 5 min, charged only on failure), per token (120/min), per grant (300/min); `AB_RATE_LIMIT_*` and `AB_RATE_LIMIT=off`; trusted proxy hops (default 0).
- 429 with `Retry-After`; limiter errors fail open with a log line (writes fail closed later, P7-03).

## Acceptance criteria
- [ ] Tests: a valid token is never locked out by others' failures; proxy-hop handling; each limit and its error.

## Security notes
THREAT_MODEL T1, T5, T20.

## Lessons applied
- L-079 — Separate abuse controls per surface.
- L-080 — Decide fail-open vs fail-closed for each control, and test it.
- L-081 — Per-process limits are not deployment-wide.

## Docs to update
- docs/guide/configuration.md

## Out of scope
- Anything not listed under Scope.
