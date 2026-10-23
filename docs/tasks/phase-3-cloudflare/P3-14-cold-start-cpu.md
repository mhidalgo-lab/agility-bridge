---
id: P3-14
title: Cut the Worker's cold-start CPU under the Free plan's budget
phase: 3
status: done
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
- [x] ~~Staging: the first request of a new isolate under 10 ms CPU in `wrangler tail` (several samples).~~ Changed by
      D-27 (b): cut what our code controls, measure it on staging and document the remaining overrun as a tolerated
      risk with Paid as the way out (`docs/guide/cloudflare-limits.md`).
- [x] No change to the security checks at boot (wrong key, unknown settings, admin token format) — the boot-failure
      tests still pass; L-096 tests still pass.

## Decision
D-27 (b), 2026-10-22: stay on Free and accept the overrun. The original criterion was not met: after this task the first request of a new isolate uses 20–40 ms (bare boot) and
45–86 ms (first MCP request) on staging, down from 60–129 ms. The rest is outside our code (the MCP SDK's first-request
schema build) or inherent (crypto, D1 round trips). See D-27 in [pending decisions](../../pending-decisions/phase-3.md).

## Done in this task
- Module scope (startup, not the request's budget): the tool registry and the JSON Schemas `tools/list` hands out
  (`prewarmToolSchemas`, the SDK's `draft-2020-12` target).
- The admin API is built on the first admin request (Workers); the request id reaches its audit rows through an
  internal header the server sets (tested, a client copy is replaced).
- The boot derives only the keys requests use (credentials, key check, audit identity); the routers of the Worker's
  apps are `LinearRouter` (no compile step).
- Measured on staging with `wrangler tail` after each change: about 96 ms → 69 → 47 → 45–55 ms for the first MCP
  request; the benchmark mirrors the Worker's module scope, baseline refreshed.

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
