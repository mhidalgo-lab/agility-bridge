---
id: P5-22
title: Key the OAuth abuse counters with a secret
phase: 5
status: dropped
priority: low
depends_on: [P5-10]
adr: ["0007"]
lessons: [L-074, L-097]
owner: ""
---

# P5-22 — Key the OAuth abuse counters with a secret

> **Dropped 2026-10-28:** D-78 chose (a): pseudonymous, short-lived counters, documented. Reopen if a deployment's privacy position needs a keyed hash.

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7), after the owner answers
> [D-78](../../pending-decisions/phase-5.md). Created by the Phase 5 review (P5-10).

## Goal
A copy of the database does not reveal which addresses used the OAuth endpoints in the last window. The counters are keyed by a
plain SHA-256 prefix of the address, and an IPv4 address can be recovered from it by trying all 2^32.

## Scope
- Key `oauth-abuse:`, `oauth-dcr-ip:` and `oauth-cimd-ip:` counters (and the cap audit markers that name an address, if any) with an HMAC
  under a key derived from the master keyring for a new purpose (ADR-0007), read once per isolate and kept as a completed
  value (L-096), not per request.
- A key rotation must not reset every limit at once: accept the previous version's key for the window that is running, or
  take the reset as the documented cost of a rotation (decide in the refinement).
- Measure the extra cost on Workers (a key read per limited request on D1's Free plan, L-097) before building.

## Acceptance criteria
- [ ] A scan of the `kv` table for the hash of a known address, with the address and the unkeyed hash as needles, finds
  nothing (memory, SQLite, D1).
- [ ] The counters still hold per address, per IPv6 /64 and per deployment, and the flood suites pass unchanged.
- [ ] The cost per request is recorded in the review notes.

## Security notes
THREAT_MODEL T25 (no personal data beyond what is needed), T20, T21 (no module-level request state).

## Lessons applied
- L-074 — The master key never lives next to the data.
- L-097 — Design for the Free plan's limits.

## Docs to update
- docs/dev/oauth.md, docs/THREAT_MODEL.md, docs/security/logging.md if rows change

## Out of scope
- The general per-IP limiter's keys, which live in memory or Cloudflare's binding and never in the database.
