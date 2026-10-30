---
id: P8-35
title: Public catalogue response cache and query-cache single flight
phase: 8
status: todo
priority: low
depends_on: [P8-11, P8-01]
adr: ["0010"]
lessons: [L-113, L-424]
owner: ""
---

# P8-35 — Public catalogue response cache and query-cache single flight

> Filed by the Phase 8 review ([P8-12](P8-12-phase-8-review.md), `docs/reviews/phase-8-review.md`).

## Goal
Cut repeated work the Phase 8 review found on two hot paths: the anonymous `tools/list` rebuilt per request, and identical cache misses that all go to Agility.

## Scope
- Public catalogue (review P-8): keep the serialised answer of `tools/list`, `initialize` and `server/discover` in an isolate-level map keyed by method and protocol version, substitute the JSON-RPC `id`, and count these requests separately from authenticated ones. The answer must stay byte-identical for every workspace name and read no storage. A POST response is not cacheable by browsers or the Cache API, so no `Cache-Control` is added.
- Query cache (review P-10): single flight for concurrent identical misses within one request (the call budget allows 6 in parallel) and drop expired entries behind a live head in `#remember`. Sharing a promise **across** requests is not allowed on Workers (workerd forbids I/O objects of another request); the task decides between per-request single flight only and a documented cross-request limit.
- Optional: batch OTLP spans per isolate on Workers with a time or size flush through `waitUntil` (review P-3).

## Acceptance criteria
- [ ] The catalogue's three answers are served from the isolate map after the first build, with a test that the bytes equal the uncached answer for every slug and that storage is untouched.
- [ ] A test with concurrent identical reads in one request shows one Agility request; a test shows a different scope never shares.
- [ ] `pnpm bench:worker` shows the catalogue and the repeat-read scenarios (see P8-37).

## Security notes
THREAT_MODEL T16, T33.

## Lessons applied
- L-113
- L-424

## Docs to update
- docs/guide/self-hosting.md, docs/guide/query-cache.md

## Out of scope
- Cross-request promise sharing on Workers.
