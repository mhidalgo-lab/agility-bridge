---
id: P3-01
title: Worker entry, bindings and boot single-flight
phase: 3
status: todo
priority: high
depends_on: [P2-17]
adr: ["0004", "0006"]
lessons: [L-083, L-086, L-096, L-151]
owner: ""
---

# P3-01 — Worker entry, bindings and boot single-flight

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
The same HTTP app runs as a Cloudflare Worker with D1, secrets and bindings.

## Scope
- `apps/worker` entry: environment parsing, bindings (D1, rate limiting, optional Durable Object), secrets (`AB_MASTER_KEY`, `AB_ADMIN_TOKEN`).
- Boot single-flight per request; never await I/O started by another request; cache only completed values.
- Security headers (including HSTS) on boot-failure responses.

## Acceptance criteria
- [ ] workerd integration tests for MCP calls, admin API and boot failures.
- [ ] No module-level request state (shared concurrency test runs on workerd too).

## Security notes
THREAT_MODEL T20, T21.

## Lessons applied
- L-083 — Derive security headers from the public URL.
- L-086 — OAuth state lives in shared storage.
- L-096 — Never share in-flight I/O between requests on Workers.
- L-151 — Health endpoints reveal nothing.

## Docs to update
- docs/guide/cloudflare-deploy.md (P3-07)

## Out of scope
- Anything not listed under Scope.
