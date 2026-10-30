---
id: P8-40
title: "Deep links: parse the base once and keep links under the output cap"
phase: 8
status: review
priority: low
depends_on: [P8-02]
adr: ["0015"]
lessons: [L-423, L-038]
owner: ""
---

# P8-40 — Deep links: parse the base once and keep links under the output cap"

> Filed by the Phase 8 review ([P8-12](P8-12-phase-8-review.md), `docs/reviews/phase-8-review.md`).

## Goal
Make deep links cheap and bounded (review P-6): `pinnedBase` and a second `new URL` run per row (about 16 microseconds a row, 11 ms at 1,000 rows) and the links are added after the output caps.

## Scope
- Parse the base once per call; build the link by concatenation after the strict OID or number check and verify origin and path without a second parse of every link.
- Count the added characters against a fixed budget (the default data block cap, 24,000 characters, about 250 rows of links): rows past it get no `url` and the one fixed note says how many (D-318). The links are added after the output caps, so this is what bounds them.
- Keep every T26 guarantee: the origin and path stay pinned, identities stay strict, a Link asset's own `url` is untouched.

## Acceptance criteria
- [x] The existing link tests pass unchanged and a new test pins the byte count under the cap.
- [x] The base is parsed once per call (a test counts `new URL`) and no second parse runs per link.
- [ ] A bench row (P8-37) shows the per-row cost under a few microseconds (local and indicative: the machine is loaded).

## Security notes
THREAT_MODEL T26.

## Lessons applied
- L-423
- L-038

## Docs to update
- docs/guide/output-formats.md

## Out of scope
- New link kinds.
