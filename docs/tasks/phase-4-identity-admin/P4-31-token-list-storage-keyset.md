---
id: P4-31
title: "Keyset paging for device tokens in storage"
phase: 4
status: done
priority: low
depends_on: [P4-15]
lessons: [L-071]
owner: ""
---

# P4-31 — Keyset paging for device tokens in storage

> Found while building P4-15: `GET /tokens` reads every token and pages in the service. Live tokens are capped at 20 per grant, so
> the read stays small, but revoked and expired rows accumulate and the read grows with history.

## Goal
Let the storage return one page of tokens by `(created_at, id)` so the admin API reads only what it shows.

## Scope
- `accessTokens.page({ grantIds?, after?, limit })` on the memory, SQLite and D1 adapters, with an index on `(created_at, id)`
  in one migration history (L-071), and a contract test run against every adapter.
- `GET /tokens` and the guards use it; the output and the cursor format do not change.

## Acceptance criteria
- [x] The same contract test passes on memory, SQLite and D1; the admin API suite is unchanged.

## Docs to update
- None beyond the storage notes in docs/ARCHITECTURE.md if they list the repository methods.

## Out of scope
- Purging old tokens.
