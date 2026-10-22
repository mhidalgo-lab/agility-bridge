---
id: P3-01
title: Worker entry, bindings and boot single-flight
phase: 3
status: review
priority: high
depends_on: [P2-17]
adr: ["0004", "0006", "0007", "0010"]
lessons: [L-083, L-086, L-096, L-151]
owner: ""
---

# P3-01 — Worker entry, bindings and boot single-flight

> Refined 2026-10-22 (tasks/README rule 7).

## Goal
The same HTTP app that `agility-bridge serve` runs (MCP per workspace, admin API, health) runs as a Cloudflare Worker
with D1, secrets and bindings, without sharing in-flight I/O between requests.

## Scope
- **Shared server settings and assembly** (`packages/http-app`): the `AB_*` settings both hosts read (public URL,
  hosts, origins, environment, access cache, budgets, limits, rate limits, pass-through, log level) parsed from a
  plain string record by one web-standard function, and the app assembled by one function from storage, keyring,
  host services and settings. `apps/cli` `serve` uses both (no behaviour change; its tests stay green); the Worker uses
  both. Node-only settings (paths, host, port, proxy hops, CA bundles) stay in the CLI.
- **Per-request isolation** (`isolation: 'request'`, Workers; Node keeps `'process'`), L-096:
  - audit rows are written as they happen and handed to the request's `waitUntil` (no shared write chain);
  - the per-credential concurrency limiter is created per request;
  - metadata loads and pass-through validations are never shared in flight between requests (completed values are
    still cached).
- **`apps/worker` entry**: `fetch` and the bindings `DB` (D1), secrets `AB_MASTER_KEY` (and `AB_MASTER_KEY_PREVIOUS`),
  optional `AB_ADMIN_TOKEN`, and `AB_*` variables. A minimal D1 `SqlDriver` (`query`, `batch`, `close`) so the SQL
  storage runs on D1; the full contract suite, concurrent first boots and constraint mapping on D1 are P3-02.
- **Boot single-flight per request**: the first request in an isolate (or the first after a failed boot) parses the
  settings, imports the keyring, applies migrations and verifies the key-check values, then caches only the completed
  result; a concurrent request runs its own boot instead of awaiting another request's; a failed boot is not cached.
- **Boot failures** answer `503` with a generic body (no setting names or values) and the security headers, including
  HSTS when `AB_PUBLIC_URL` is HTTPS (L-083); the cause is logged to the Workers log, redacted. `/health` stays
  `{"status":"ok"}` and reveals nothing (L-151).
- No `nodejs_compat` (ADR-0004); no Node built-ins in the bundle (checked).

## Acceptance criteria
- [x] workerd integration tests (local, `wrangler`'s Miniflare with a local D1; no Cloudflare account) for: an MCP
      `tools/list` and tool call with a device token against the synthetic Agility, the admin API with the
      break-glass token, the uniform 401, `/health`, and boot failures (missing or malformed master key, wrong master
      key) with security headers and no detail in the body.
- [x] No module-level request state: the two-workspace concurrency test from P2-12 runs against the Worker too, and
      concurrent first requests each boot on their own (no request awaits another's boot).
- [x] Unit tests for the isolation mode: no shared audit chain, a limiter per request, no shared in-flight metadata
      load or pass-through validation; `serve` unchanged.
- [x] The Worker bundle builds with `wrangler deploy --dry-run` and contains no `node:` import.

## Security notes
THREAT_MODEL T20, T21. Secrets only as Worker secrets, never `vars` (the setup script, P3-05, enforces it).

## Lessons applied
- L-083 — Derive security headers from the public URL.
- L-086 — OAuth state lives in shared storage.
- L-096 — Never share in-flight I/O between requests on Workers.
- L-151 — Health endpoints reveal nothing.

## Docs to update
- docs/ARCHITECTURE.md (deployment mode D: request isolation)
- docs/THREAT_MODEL.md (T21), docs/security/logging.md, docs/LESSONS-LEARNED.md (L-179)
- docs/guide/cloudflare-deploy.md (P3-07)

## Notes
- Local workerd does not flag a promise shared between requests (L-179), so the boot rule is tested on the handler
  (`apps/worker/test/handler.test.ts`) and the app's isolation mode in `packages/http-app/test/isolation.test.ts`, each
  mutation-checked; the workerd suite (`apps/worker/test/worker.test.ts`) covers the end-to-end paths.
- The bundle is 1.98 MiB, 380 KiB gzipped (Free allows 3 MB compressed).

## Out of scope
- D1 contract suite and migration concurrency (P3-02), Workers limits presets (P3-03), rate-limit bindings (P3-04),
  the setup script (P3-05), the full workerd suite and CI wiring (P3-06), scheduled jobs (P3-08).
