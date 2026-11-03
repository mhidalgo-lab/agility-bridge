---
id: P3-16
title: Measure the Durable Object limiter on the staging Worker
phase: 3
status: todo
priority: low
depends_on: [P3-12]
adr: ["0010"]
lessons: [L-099, L-097]
owner: ""
---

# P3-16 — Measure the Durable Object limiter on the staging Worker

> Created by P3-12: its tests are local (workerd in Miniflare); billed requests, latency and placement need a real account. An owner step.

## Goal
The cost note and the exactness claims of the Durable Object limiter are checked against a real deployment.

## Scope
- Deploy the object to the staging Worker (migration `new_sqlite_classes`), run a flood of failed authentications from two
  locations or a flood of one address, and read the Durable Object request counts and duration from the dashboard or GraphQL.
- Record the latency of a call from a distant location and the 1.5 s timeout's fit.

## Acceptance criteria
- [ ] *owner / live:* billed Durable Object requests per failed authentication, OAuth request and write recorded in the guide.
- [ ] *owner / live:* exactness shown with requests from two locations; the failing-open path shown by removing the class.

## Security notes
THREAT_MODEL T1, T20.

## Lessons applied
- L-099 — Judge a limiter by what it does across locations.
- L-097 — The Free plan's request and duration budget.

## Docs to update
- docs/guide/cloudflare-limits.md, docs/THREAT_MODEL.md

## Out of scope
- Changing the shard count or timeout without data.
