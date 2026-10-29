---
id: P7-03
title: Deployment-wide write limiter
phase: 7
status: todo
priority: high
depends_on: [P7-01]
adr: ["0010"]
lessons: [L-080, L-081, L-111]
owner: ""
---

# P7-03 — Deployment-wide write limiter

> Refined 2026-10-29 before starting (tasks/README rule 7).

## Goal
Write limits hold across processes and isolates.

## Scope
- A `WriteLimiter` (the P7-01 seam, after approval and before the re-read) that takes one unit from two counters per
  write: the grant's (default 20 an hour, `AB_WRITE_RATE_PER_GRANT_HOURLY`) and the deployment's (default 200 an hour,
  `AB_WRITE_RATE_DEPLOYMENT_HOURLY`). Counters are fixed hourly windows in the storage `kv` table (`kv.increment` with a cap,
  atomic on memory, SQLite and D1), so every isolate and replica of a deployment shares them. No new Cloudflare resource
  (the optional Durable Object limiter stays P3-12; trade-off in D-168).
- Fails closed: a counter store that errors, or answers something other than a count, refuses the write with
  `AB_WRITE_LIMIT_UNAVAILABLE` (a new code; nothing was changed, no upstream call, no intent audit).
- A refusal is `AB_LIMIT_RATE` with the scope (`grant` or `deployment`), the limit and the seconds until the window ends.
- stdio: the same limiter over an in-process counter store, grant limit only (one process, one actor).
- The limiter holds no state besides its counters (T21); keys carry the window, so nothing needs cleaning up (expired
  entries are purged by the scheduled job).
- Docs: write-tools guide, configuration reference, THREAT_MODEL T31 and A2, ARCHITECTURE write pipeline.

## Acceptance criteria
- [ ] The limiter refuses the (limit+1)th write of a grant in a window and the (limit+1)th of the deployment, with
      `AB_LIMIT_RATE` naming the scope; a new window allows again.
- [ ] A refused write makes no upstream call (no re-read, no send) and writes no intent audit row.
- [ ] Concurrency: parallel checks (separate limiter instances over one store, standing for isolates) never admit more
      than the limit, on memory, SQLite and workerd/D1.
- [ ] Limiter outage (store throws, or returns garbage) refuses the write with `AB_WRITE_LIMIT_UNAVAILABLE`, no upstream
      call, no intent audit; the outage does not open the write.
- [ ] A grant over its limit does not spend the deployment budget; one grant's use does not spend another grant's.
- [ ] Both hosts are wired (HTTP: `kv`; stdio: memory) and the limits are settings with validated ranges.
- [ ] Docs, threat model and error table updated; error code in the contract snapshot.
- [ ] Not verifiable here: behaviour under real Workers traffic (P7-10 staging) and a per-grant override set by an owner
      (P7-15).

## Out of scope
- Exact sliding windows, a Durable Object limiter (P3-12) and per-grant limits editable in the admin UI (P7-15).
- Bounding approval prompts before the approval (D-157 (c)).

## Security notes
THREAT_MODEL T31, A2.

## Lessons applied
- L-080 — Decide fail-open vs fail-closed for each control, and test it.
- L-081 — Per-process limits are not deployment-wide.
- L-111 — Write limits are deployment-wide.

## Docs to update
- docs/guide/write-tools.md, docs/guide/configuration.md, docs/THREAT_MODEL.md, docs/ARCHITECTURE.md
