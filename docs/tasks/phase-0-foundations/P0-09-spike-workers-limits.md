---
id: P0-09
title: "Spike: Cloudflare Workers limits with Agility-shaped payloads"
phase: 0
status: done
priority: high
depends_on: [P0-01]
adr: ["0010", "0014"]
lessons: [L-001, L-049, L-096, L-097, L-098, L-099, L-101, L-159, L-160, L-161]
owner: "Matias Hidalgo"
---

# P0-09 — Spike: Cloudflare Workers limits with Agility-shaped payloads

## Goal
Measure CPU, subrequests, memory and cache behaviour on the Free and Paid plans for the request shapes agility-bridge will generate.

## Scope
- A Worker in front of a mock Agility upstream returning 10 KB – 5 MB JSON and XML.
- CPU p50/p95 for parsing and shaping, cold starts, D1 round trips, subrequests per tool call including retries.
- Cache API on `workers.dev` vs a custom domain; Rate Limiting binding behaviour.
- XML parser candidates for `meta.v1` (CPU, bundle size, entity handling).
- Outbound fetch to a host with a private CA (expected failure) and, optionally, to an instance behind a tunnel.
- Storage and crypto portability prototype: the same schema and conditional statements on `node:sqlite` and local D1, and WebCrypto AES-256-GCM + HKDF round trips across Node and workerd (input for ADR-0006 and ADR-0007).

## Acceptance criteria
- [x] `spikes/workers-limits/RESULTS.md` with numbers per plan. *(Free: measured in production on 2026-10-20. Paid: not available on the owner's account; the Paid presets keep the documented limits.)*
- [x] Response caps and budget presets in ADR-0010 confirmed or changed.
- [x] XML parser chosen with measurements.
- [x] The private-CA limitation recorded for ADR-0014.
- [x] The storage and crypto prototype passes on both runtimes, or the differences are recorded for ADR-0006 and ADR-0007.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-001 — Measure before you build.
- L-049 — Cap bytes before parsing.
- L-096 — Never share in-flight I/O between requests on Workers.
- L-097 — Design for the Free plan's limits, not its tolerance.
- L-098 — The Cache API is local and sometimes a no-op.
- L-099 — The Rate Limiting binding is a backstop.
- L-101 — Count budgets in audit records, not headers.

## Docs to update
- docs/RESEARCH.md §5
- docs/adr/0010-platform-limits-strategy.md
- docs/adr/0014-supported-agility-installations.md

## Out of scope
- The production Worker (Phase 3)
