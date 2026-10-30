---
id: P8-40
title: "Deep links: parse the base once and keep links under the output cap"
phase: 8
status: todo
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
- Count the added bytes against the output cap, or omit links above about 200 rows with a note.
- Keep every T26 guarantee: the origin and path stay pinned, identities stay strict, a Link asset's own `url` is untouched.

## Acceptance criteria
- [ ] The existing link tests pass unchanged and a new test pins the byte count under the cap.
- [ ] A bench row (P8-37) shows the per-row cost under a few microseconds.

## Security notes
THREAT_MODEL T26.

## Lessons applied
- L-423
- L-038

## Docs to update
- docs/guide/output-formats.md

## Out of scope
- New link kinds.
