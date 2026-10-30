---
id: P8-13
title: Verify the query cache shared tier on a deployed Worker
phase: 8
status: todo
priority: low
depends_on: [P8-01]
adr: ["0010"]
lessons: [L-098, L-113]
owner: ""
---

# P8-13 — Verify the query cache shared tier on a deployed Worker

## Goal
Replace the *unverified* claims about the Workers Cache API tier (P8-01) with measurements from a deployed Worker, so the owner can decide whether `AB_QUERY_CACHE_EDGE` is worth recommending.

## Scope
- On the `agility-bridge-staging` Worker with `AB_QUERY_CACHE_TTL` and `AB_QUERY_CACHE_EDGE=on`, over `workers.dev` and, if the owner has one, a custom domain: read `whoami` (`queryCache.shared`) after the first cached read and record `verified` or `unavailable` per hostname.
- Whether `cache.put` and `cache.match` count against the Free plan's 50 subrequests per request (they may); the cost of a sealed shared-tier hit in CPU on workerd (the bench's 1.4 ms is Node, P0-09).
- Whether a hit from a second data centre or isolate is seen (the Cache API is local to a data centre): record what happens, do not promise more.
- Update `docs/guide/query-cache.md`, `docs/guide/cloudflare-limits.md` and `docs/RESEARCH.md` with dates and sources; mark the guide's unverified notes verified or reword them.

## Acceptance criteria
- [ ] Per hostname status and the subrequest and CPU numbers recorded in RESEARCH.md with the date.
- [ ] The guide and `cloudflare-limits.md` say what was measured; the setting's default stays off unless the owner decides otherwise.

## Security notes
THREAT_MODEL T16. Use only synthetic data in the staging Worker; never the live Agility tenant.

## Lessons applied
- L-098 — Validate the Cache API by reading back, and report its status honestly.

## Docs to update
- docs/guide/query-cache.md, docs/guide/cloudflare-limits.md, docs/RESEARCH.md

## Out of scope
- Creating Cloudflare resources beyond the staging Worker and its D1 database.
