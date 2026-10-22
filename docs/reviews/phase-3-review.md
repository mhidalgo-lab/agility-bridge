# Phase 3 review

- **Scope:** all Phase 3 code (P3-01 … P3-10, P3-13, P3-14, and P2-19 done alongside): `apps/worker` (entry, boot,
  plans, rate-limit backstop, scheduled jobs), the D1 driver and the access bundle, the shared settings and assembly
  with request isolation, the lazily built admin API and `/keys` routes, the instance URL policy, and the Cloudflare
  scripts (`cf:setup`, `cf:migrate`, `bench:worker`, `staging-smoke`).
- **Date:** 2026-10-22. **Branch:** `task/P3-11-phase-3-review`, on top of `main` after #80.
- **Method:** an adversarial read by a separate reviewer with a fresh context in an isolated worktree, reproducing each
  claim with throwaway tests against local workerd, local D1 and a fake wrangler (no Cloudflare, Agility or secrets).
  Every finding below has a regression test, and the fixes were mutation-checked (the test fails with the fix
  reverted, L-121). Live on Cloudflare: the staging deployment (`agility-bridge-staging`, Free plan) and the smoke
  checks, MCP Inspector over HTTPS, `wrangler tail` CPU samples.
- **Checks:** `pnpm lint && pnpm typecheck && pnpm test` green; the staging smoke checks green; the Worker CPU benchmark
  within its baseline.

## Verdict

**Ready, with one open owner decision.** No high finding; two medium and five low ones are fixed here with regression
tests, and the review confirmed request isolation, ceilings, the access bundle, migration literals, the rate-limit
backstop, the `/keys` authorization and the setup script. The open item is the cold start on the Free plan: the first
request of a new isolate still uses 20–86 ms of CPU against a 10 ms budget (decision D-27, P3-14 blocked). P3-12 (an
exact Durable Object limiter) is optional and stays open.

## Per-task completeness

| Task | PR | Status | Evidence / gap |
|---|---|---|---|
| P3-01 Worker entry | #65 | met | shared settings and assembly, request isolation (L-096, L-179), boot per request, workerd tests |
| P3-02 D1 adapter | #67 | met | the whole storage contract on local D1, concurrent first boots, access in one batch |
| P3-03 limits presets | #68 | met | `AB_PLAN`, Free ceilings, hidden tools, usage in audit rows |
| P3-04 rate limiting | #69 | met | local buckets plus the Rate Limiting binding backstop, fail-open tested; exact limiter is P3-12 |
| P3-05 setup script | #71 | met | idempotent `cf:setup`, created staging for real (L-180) |
| P3-06 workerd suite | #72 | met | the P2-12 denial matrix on workerd with zero Agility requests |
| P3-07 Cloudflare docs | #78 | met, owner step | deploy guide with custom domain, WAF exception, costs; custom domain on a zone is the owner's |
| P3-08 scheduled jobs | #74 | met | cron in bounded slices, resumable rotation behind a lease |
| P3-09 migration | #75, #76 | met | real migration into staging (L-181) |
| P3-10 CPU benchmark | #77 | met | local and staging numbers, non-required CI job with history |
| P3-13 key admin | #79 | met | `/keys` routes, `init --version`, rotation end to end on workerd |
| P3-14 cold start | #80 | blocked (D-27) | 60–129 ms → 20–86 ms; under 10 ms needs the MCP SDK or the Paid plan |
| P2-19 instance URL policy | #70 | met | HTTP loopback refused by servers, optional public-only mode |
| P3-12 Durable Object limiter | — | open (optional) | not needed for Phase 4; the binding backstop is the accepted residual risk |

## Findings

Status: **fixed** (this branch, regression test, mutation-checked), **documented** (a behaviour now stated in the
guides).

### Medium

**M1 — `POST /keys/{version}/retire` accepted a version the deployment never used** — **fixed.** Retiring version 5 on
a deployment on version 1 succeeded, and a later boot with a version-5 key then failed for good (`retired`), with no
API to undo it. `retireKeyVersion` now accepts only an earlier version with a recorded key-check value
(`admin.test.ts`). Lesson L-183.

**M2 — The audit row of a retirement lost the operator's reason** — **fixed.** The route recorded only the body's
field names after the service stopped writing its own row (P3-13). Routes can now name body values to keep with the
row (`auditBody`); the retirement keeps `reason`, truncated to 200 characters (`scheduled.test.ts`, end to end).

### Low

- **L1 — `cf:migrate` read a failed row-count query as "empty"** — **fixed:** once the schema is there, a failed count
  or key-check query stops the migration before anything is written.
- **L2 — `cf:migrate` did not check `--name` or that the local config belongs to it** — **fixed:** the same name rule
  and config ownership check as `cf:setup` (T34).
- **L3 — the Worker's lazily built admin API answered unknown paths with plain text and logged whole errors** —
  **fixed:** the same JSON `404`/`500` and name-only logging as the main app.
- **L4 — `addressClass` called several non-public forms public** (IPv4-compatible and SIIT IPv6, NAT64, 6to4,
  site-local, discard, special and documentation IPv4 ranges) — **fixed:** embedded IPv4 is classified as that
  address; the ranges are reserved or private.
- **L5 — `cf:setup` sent a new secret to Cloudflare before writing it to the secrets file** — **fixed:** written and
  flushed first, so a crash cannot leave a master key only Cloudflare holds.
- **Documented** — a revocation reaches other isolates within the access-cache time (≤ 60 s, as T15 says), and the
  Worker has no private-address setting because it cannot reach private networks
  ([deploy guide](../guide/cloudflare-deploy.md#things-that-differ-from-a-single-server)).

## Checked and sound (reviewer)

The internal request-id header is always replaced by the server; only completed values are shared between requests
(boot, keyring, limiters, metadata, pass-through, the lazy admin app); workspace and grant limits are capped by the
plan's ceilings and bad settings stop the boot with a bare `503`; `bundleByHash` keys every read correctly and the
resolver still rejects another workspace's token; D1 errors are classified like SQLite's; migration literals
round-trip quotes, `;`, newlines and emoji (control characters cannot reach stored text); the rotation lease is
reclaimable and released, each job fails alone, a cron run stays near 40 D1 queries (a thin margin under Free's 50);
the rate-limit backstop routes keys by prefix, caps its memory and never locks out valid tokens; `/keys` is owner-only
with a recent sign-in for retirement; `cf:setup` passes secrets through stdin into a `0600` file and refuses another
deployment's config; the Node instance policy refuses every private, loopback and mapped form tried (`127.1`,
`2130706433`, `localhost.`, `::ffff:127.0.0.1`).

## Live verification (staging, 2026-10-22)

- `pnpm cf:setup`, a second run, `pnpm cf:migrate` and the guide's `instance add` through the Worker's admin API
  ([verification](../dev/verification.md#cloudflare-deployment-p3-05-p3-07)).
- `node scripts/staging-smoke.ts https://agility-bridge-staging.<subdomain>.workers.dev`: health and version with the
  security headers (HSTS), the uniform `401` for no and for a made-up token, the admin API closed, JSON `404`, a hostile
  `Origin` refused; with the migrated device token, `tools/list` lists 13 tools. The *Staging smoke* workflow runs the
  same checks by hand with the address as input.
- MCP Inspector CLI 2.11.0 over HTTPS with the device token: `tools/list` (13 tools) in the 2025 era and in
  2026-07-28; without a token it is refused and offers OAuth (Phase 5).
- Multi-isolate behaviour: requests after a deploy land on several new isolates (each boots on its own, L-096); the
  rate-limit backstop and the access-cache TTL are the cross-isolate controls.
- Owner's runs: VS Code, JetBrains, Copilot CLI, Claude Code and Cursor over HTTPS against the Worker.

## Go / no-go for Phase 4

**Go**, recommended: the Worker is deployed, tested on workerd and on Cloudflare, and reviewed. Phase 4 (identity and
the admin panel) does not depend on D-27; production on the Free plan does. Recorded as D-28 in
[pending decisions](../pending-decisions/phase-3.md).
