---
id: P7-15
title: Per-grant write limit set by an owner
phase: 7
status: done
priority: low
depends_on: [P7-03, P4-05]
adr: ["0013"]
lessons: [L-081, L-111]
owner: ""
---

# P7-15 — Per-grant write limit set by an owner

> Filed by P7-03 ([write limiter](P7-03-write-limiter.md), D-169 (c)). Refine scope and acceptance criteria before starting.

## Goal
An owner can lower (never raise above the deployment setting) the hourly write limit of one grant.

## Scope
Refined 2026-10-29.

- The grant's existing `rateLimit` JSON gains `writesPerHour` (whole number, 1 to 1,000), next to `perMinute`: no storage migration and no new column in the three adapters (D-225). It is a **cap**: the write runtime passes the lower of it and the deployment's `AB_WRITE_RATE_PER_GRANT_HOURLY` to the limiter, so lowering the deployment value later still applies, and a value above the deployment's would have no effect.
- Setting one above the deployment's value is refused (`422`, naming the deployment value) in the admin API for `POST /grants` and `PATCH /grants/{id}`; the admin API (and the CLI's in-process client) are given the deployment value.
- Setting, changing or removing `writesPerHour` is **owner-only with a recent sign-in** (an admin cannot loosen a limit an owner set); the change is in the `grant.create` / `grant.update` audit row (`writesPerHour` and `previousWritesPerHour`, numbers only).
- Panel: an owner sees "Writes per hour" on the grant form (blank: the server's value) and on the grant page; an admin sees the value read-only and the form keeps it. The form no longer drops it when it saves the per-minute rate.
- CLI: no grant command sets any rate today (`grant add` has no rate option and there is no `grant update`), so there is nothing to extend; recorded as follow-up P7-40.
- The limiter's counter key is unchanged: a lowered cap applies from the next write in the current window.

## Acceptance criteria
- [x] A grant limit below the deployment's applies (the write is refused at the lower count); one above it is refused when set.
- [x] Owner-only, recent sign-in, audited; negative authorization tests (admin, member, stale sign-in, no credentials; nothing changes).
- [x] Generated admin API reference refreshed; the CLI has no grant rate settings (P7-40).

## Security notes
THREAT_MODEL T31, A2.

## Lessons applied
- L-111 — Write limits are deployment-wide.

## Docs to update
- docs/guide/write-tools.md, docs/guide/admin-panel.md

## Out of scope
- Anything not listed under Scope.
