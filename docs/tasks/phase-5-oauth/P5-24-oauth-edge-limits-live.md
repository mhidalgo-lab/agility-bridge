---
id: P5-24
title: Check the OAuth edge limits on a real zone and Worker
phase: 5
status: todo
priority: low
depends_on: [P5-19]
adr: ["0010"]
lessons: [L-099, L-477]
owner: ""
---

# P5-24 — Check the OAuth edge limits on a real zone and Worker

> Created by P5-19: its local checks cannot reach Cloudflare. An owner step, no code unless a check fails.

## Goal
The `RL_OAUTH` binding and the documented WAF rate limiting rule are shown to behave as the guide says on a real deployment.

## Scope
- Deploy to the staging Worker with `RL_OAUTH` and confirm a flood from one address gets `429` from the binding and that D1 rows
  written (`meta.rows_written`) stop growing after it refuses; a normal connect flow from a real MCP client is never refused.
- Create the WAF rule from `docs/guide/cloudflare-limits.md` on a zone you own, check the period and request numbers your plan
  allows, and correct the recipe.

## Acceptance criteria
- [ ] *owner / live:* a flood against the staging Worker with and without the binding, D1 `rows_written` recorded in the guide.
- [ ] *owner / live:* the WAF rule created on a real zone; the recipe corrected to what the plan allowed; the "unverified" mark removed.

## Security notes
THREAT_MODEL T20.

## Lessons applied
- L-099 — The binding is eventually consistent: judge it over a minute, not per request.
- L-477 — Count the thing the plan bills.

## Docs to update
- docs/guide/cloudflare-limits.md, docs/THREAT_MODEL.md

## Out of scope
- Changing the limits' defaults without data.
