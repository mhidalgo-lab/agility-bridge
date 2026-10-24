---
id: P5-09
title: Abuse controls for unauthenticated endpoints
phase: 5
status: review
priority: medium
depends_on: [P5-03]
adr: ["0010"]
lessons: [L-079, L-081, L-089, L-097, L-121, L-251]
owner: "claude-agent"
---

# P5-09 — Abuse controls for unauthenticated endpoints

> Refined 2026-10-24 (tasks/README rule 7), after P5-01, P5-03 and P5-04 (their Outcomes name this task as the owner of
> the per-surface limits and the sweep schedule) and relic-bridge's Phase 5 review (M1, L4 already folded into P5-03).

## Goal
Public OAuth endpoints cannot be used to exhaust storage, outbound fetches or the Free plan's write budget, and one
address cannot lock the others out (except through the documented deployment-wide caps).

## Scope
- **One limiter design for the OAuth surfaces**: fixed-window counters in the shared `kv` table, taken with the store's
  atomic `increment` (`max`): SQLite on Node, D1 on Workers. Not a second token-bucket design: the general per-IP limiter
  (P2-07, per isolate plus the `RL_IP` backstop on Workers) stays in front, and these counters are the shared, exact part
  that an isolate's memory could never be (L-081). Per address first, then the deployment (L-251). The address is hashed.
- **Surfaces and defaults** (all settings, bounds 1 - 100,000, safe defaults):
  - `/oauth/authorize`: per address and in all, per 10 minutes (30, 600).
  - `POST /oauth/consent`: per address and in all, per 10 minutes (30, 300).
  - `/oauth/token`: **failed** exchanges (a `4xx` that is not a `429`) per address per 10 minutes (20), and in all (300) where
    the deployment limit only turns away addresses that already failed in the window, so a clean client is never locked
    out by someone else's failures. Successes cost no counter write. Added at the route edge (`runtime.guard`), so the
    token endpoint's own code (P5-05) is untouched.
  - `/oauth/register`: P5-03's per-address and live-client caps stay; add the deployment's registrations per hour (100),
    which bounds storage churn from many addresses.
  - CIMD fetches: P5-03's per-address budget and stored-document cap stay; add the deployment's fetches per hour (200),
    which bounds outbound requests from many addresses.
- **Cost on Workers** (D-27, L-097): a taken unit is one D1 row write; a refused increment writes nothing; a refused counter
  is remembered in the isolate until its window ends (hashed counter name and a time only), and the audit marker likewise,
  so a flood costs about `limit + 1` writes per counter and window and no reads. Fails open with a log line when the counter
  store errors (L-080).
- **Sweeps on a bound**: expired counters, markers and stale CIMD records are removed by the store's expiry purge; Node
  `serve` had **no** purge job, so it gains an hourly bounded one (plus the registration sweep); the Worker cron gains a
  bounded registration sweep (20 per run, a cursor in `kv`) next to its existing `kv_purge`. `sweepRegistrations(storage)`
  works from the storage alone, so hosts do not need the OAuth runtime.
- **Refusals**: `429` with `Retry-After` and the JSON `temporarily_unavailable` shape the OAuth routes already use; audited
  once per window, surface and scope as `oauth.request.refused` (stable reason, surface, scope, limit; no address, no
  token material, no client secret).
- Docs: `docs/dev/oauth.md`, configuration reference, THREAT_MODEL T10/T11/T20, `docs/guide/cloudflare-limits.md`,
  RESEARCH (platform facts, dated), audit-log guide.

## Acceptance criteria
- [x] Flood tests per endpoint (authorize, consent, token failures, register, CIMD) show stored rows and outbound fetches
  stay within budget, on memory, SQLite and workerd/D1.
- [x] One address flooding cannot lock out another; the deployment caps do (documented); a clean address is still served
  while the deployment's token-failure cap is exhausted.
- [x] Refusals are `429` with `Retry-After`, audited once per window, with no token, secret or address in the row, the log
  or the response.
- [x] Negative authorization: a refused request reaches no endpoint code, stores nothing, fetches nothing and asks Agility
  nothing.
- [x] Settings validated and documented; defaults safe; windows reset with fake time (no fixed sleeps).
- [x] The sweeps run on both hosts, bounded; storage rows stay bounded after a flood and a sweep.
- [x] Security tests are mutation-checked (L-121), recorded under Outcome.
- [x] Docs, THREAT_MODEL, RESEARCH, cloudflare-limits, a changeset, new lessons and decisions.

## Outcome
- Built as scoped. One limiter design (`oauth/abuse.ts`): fixed-window counters in `kv`, atomic `increment` with `max`, address
  first then deployment, the isolate remembering refused counters and audit markers (L-257). Wired at the route edge
  (`runtime.guard` in `app.ts`), so the token endpoint's code (P5-05) is untouched. P5-03's own per-address counters and caps
  stay; the deployment-wide registration (100/h) and fetch (200/h) limits are new. Settings `AB_OAUTH_AUTHORIZE_IP_LIMIT`,
  `AB_OAUTH_AUTHORIZE_LIMIT`, `AB_OAUTH_CONSENT_IP_LIMIT`, `AB_OAUTH_CONSENT_LIMIT`, `AB_OAUTH_TOKEN_FAILURE_IP_LIMIT`,
  `AB_OAUTH_TOKEN_FAILURE_LIMIT`, `AB_OAUTH_DCR_LIMIT`, `AB_OAUTH_CIMD_LIMIT` (D-72, D-73).
- Found while building: `agility-bridge serve` had no job that removes expired `kv` rows at all (L-256). It now runs a bounded purge
  at start and hourly with the registration sweep; the Worker cron gains a bounded sweep (20 per run, cursor in `kv`).
- Suites: `abuse-suite.ts` (6 flood cases) on memory, memory in the Workers shape, SQLite and workerd/D1; `abuse.test.ts` (windows,
  both caps, audit once, fail-open, no write for a remembered refusal, no address anywhere, sweeps, housekeeping, settings),
  `abuse-consent.test.ts` (the consent post on the built-in screen), `apps/worker/test/scheduled-oauth.test.ts`. `pnpm test`: 2,614
  passed, 7 failed: the five offline `npx agility-bridge` documentation tests, plus two that passed when rerun alone (a core
  seeded property and the workerd denial matrix, which timed out at 60 s while the whole suite ran).
- Mutation checks (L-121), each reverted, number of failing tests: address counter skipped (8), deployment counter skipped (7),
  token failures not counted (6), deployment failure cap hitting clean addresses (1), address failure cap ignored (4), refusal
  not remembered (1), audit once per window off (7), counter store failing closed (1, after the test asserted "below 500" instead
  of "not 429"), counters without expiry (1), token route unguarded (6), authorize route unguarded (8), consent route
  unguarded (2), token failures counted only for 200 (6), registration hourly cap off (1), fetch hourly cap off (1), sweep
  removing used registrations (1, after adding the case), sweep cursor not saved (1), sweep bound ignored (1), constant
  `Retry-After` (1). Survivor, equivalent: the sweep's skip of stored document clients (a document record has no
  `registrationDate`, so the sweep would skip it anyway; the skip only saves a read).
- Not covered: D1's billing of a statement that changes no row (unverified, no probing of the service; the design does not
  depend on it); a many-address flood over real networks; the Cloudflare edge limits (P5-19). Fixed windows allow twice a limit
  around a boundary (D-72).
- New: lessons L-256 to L-258, decisions D-72 and D-73, tasks P5-19 and P5-20.

## Security notes
THREAT_MODEL T10, T11, T20 (T9 touched).

## Lessons applied
- L-079 — Separate abuse controls per surface.
- L-081 — Per-process limits are not deployment-wide.
- L-089 — Dynamic registration is a compatibility path.
- L-097 — Design for the Free plan limits.
- L-121 — Negative authorization is first-class.
- L-251 — Cap anonymous writes per source first, and by what is stored.

## Docs to update
- docs/dev/oauth.md, docs/guide/configuration.md, docs/THREAT_MODEL.md, docs/guide/cloudflare-limits.md,
  docs/guide/audit-log.md, docs/RESEARCH.md, docs/pending-decisions/phase-5.md

## Out of scope
- Refresh rotation, the reuse window and device caps (P5-05); the admin view of registered clients (P5-08).
- Cloudflare's Rate Limiting binding for the OAuth routes and a WAF recipe (new task).
- Per-client limits on token use after issuance (the MCP route limits of P2-07 apply).
