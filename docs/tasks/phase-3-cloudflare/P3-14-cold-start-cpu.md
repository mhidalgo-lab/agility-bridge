---
id: P3-14
title: Cut the Worker's cold-start CPU under the Free plan's budget
phase: 3
status: todo
priority: high
depends_on: [P3-10]
adr: ["0010"]
lessons: [L-020, L-096, L-097]
owner: ""
---

# P3-14 — Cut the Worker's cold-start CPU under the Free plan's budget

## Goal
The first request of a new isolate fits the Free plan's 10 ms of CPU, instead of relying on Cloudflare tolerating
38–80 ms (P3-10 measurements).

## Scope
- Move everything that does not need the environment to module scope, which Workers run at startup under a separate
  limit: route tables, the admin API's OpenAPI routes and validators, the tool registry and its converted schemas
  (L-020). Keep per-environment parts (settings, keyring, storage, admin token) in the per-request boot.
- Make the boot's crypto lazy where L-096 allows it: derive purpose keys on first use per request only if that does
  not share in-flight work; otherwise derive only the purposes the request path needs at boot.
- Skip work the Worker repeats for nothing on every cold start (e.g. the key-check verification once a `kv` marker shows
  it passed for this key version, if that stays safe against a wrong key).
- Re-measure with `pnpm bench:worker` and on staging; update the baseline and `docs/guide/cloudflare-limits.md`.

## Acceptance criteria
- [ ] Staging: the first request of a new isolate under 10 ms CPU in `wrangler tail` (several samples).
- [ ] No change to the security checks at boot (wrong key, unknown settings, admin token format) — the boot-failure
      tests still pass; L-096 tests still pass.

## Security notes
THREAT_MODEL T5, T21.

## Lessons applied
- L-020 — Cache converted tool schemas.
- L-096 — Never share in-flight I/O between requests on Workers.
- L-097 — Design for the Free plan's limits, not its tolerance.

## Docs to update
- docs/guide/cloudflare-limits.md

## Out of scope
- Paid-plan-only optimisations.
