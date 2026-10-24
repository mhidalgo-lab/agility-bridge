---
id: P5-19
title: Edge rate limits for the OAuth routes on Workers
phase: 5
status: todo
priority: low
depends_on: [P5-09]
adr: ["0010"]
lessons: [L-081, L-097, L-099]
owner: ""
---

# P5-19 — Edge rate limits for the OAuth routes on Workers

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7). Created by P5-09.

## Goal
A flood of OAuth requests is stopped before it costs a D1 query, on Workers deployments that can add Cloudflare's own rate
limiting in front of the Worker.

## Scope
- A `RL_OAUTH` Rate Limiting binding (the P3-04 `RL_IP` pattern) used as a backstop for `/oauth/authorize`, `/oauth/token`,
  `/oauth/register` and the consent post, keyed by client address, fail-open, in front of the P5-09 counters.
- A documented WAF recipe (rate limiting rule on the `/oauth/*` paths) for deployments that own a zone.
- Measure: D1 rows written per day under a synthetic flood, with and without the backstop (local, no real service probing).

## Acceptance criteria
- [ ] With the binding present, a flood causes no D1 write after the binding refuses; without it the P5-09 behaviour is
  unchanged.
- [ ] The binding failing never blocks a request (fail-open, logged once a minute).
- [ ] `docs/guide/cloudflare-limits.md` and the deployment guide show both options.

## Security notes
THREAT_MODEL T20.

## Lessons applied
- L-081 — Per-process limits are not deployment-wide (the binding is per location, so it is a backstop only).
- L-097 — Design for the Free plan limits.
- L-099 — The Rate Limiting binding is eventually consistent.

## Docs to update
- docs/guide/cloudflare-limits.md, docs/guide/cloudflare-deploy.md, docs/THREAT_MODEL.md

## Out of scope
- Replacing the P5-09 counters; per-client limits.
