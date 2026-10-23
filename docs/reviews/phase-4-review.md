# Phase 4 review

- **Scope:** all Phase 4 code (P4-01 … P4-10, P4-12 … P4-15 and the chores #86, #91, #93): the identity providers and
  owner bootstrap, admin sessions and roles, the admin UI package and its screens, the audit viewer, the connect page,
  member self-service, the `cf:setup --sign-in` script, the browser E2E and ZAP workflows, the panel benchmark, and
  the admin and remote guides. The admin security review ([P4-09](phase-4-admin-security-review.md), #100) centred on
  the owner boundary of every writer and is built on, not repeated.
- **Date:** 2026-10-23. **Branch:** `task/P4-11-phase-4-review`, on top of `main` after #100 (`c1334b9`).
- **Method:** a fresh adversarial read of the cross-cutting concerns P4-09 did not centre on, reproducing each claim
  with a throwaway test against local fakes (no real tenant, no Cloudflare, no secrets). The one reproduced issue has
  a regression test that fails with the fix reverted (L-121). Live on Cloudflare: the coordinator's staging pass below.
- **Checks:** `pnpm lint && pnpm typecheck && pnpm test` green; generated files refreshed.

## Verdict

**Ready, with the owner's real-provider sign-in still to do.** No high and no medium finding. One low finding
(redaction of the new sign-in values) and two bookkeeping gaps are fixed or documented here; everything else the review
looked at was sound. The providers are tested against local fakes and a placeholder client on staging only, so a real
sign-in (*Owner steps* in [pending decisions](../pending-decisions/phase-4.md)) remains the gate for relying on them.

## Per-task completeness

| Task | PR | Status | Evidence / gap |
|---|---|---|---|
| P4-01 identity providers | #83 | met, owner step | Google, GitHub, OIDC, Cloudflare Access against fakes; real sign-in is an owner step |
| P4-02 admin sessions | #85 | met | hashed sessions in storage, CSRF, recent sign-in; the *Not exercised* items are covered by P4-08 |
| P4-03 UI scaffold | #87 | met | literal CSP on every route, lazy import, escaping lint |
| P4-04 admin screens | #88 | met | one-use form handles, role-scoped writers; owner boundaries re-checked in P4-09 |
| P4-05 audit viewer | #90 | met | keyset paging, bounded aggregates (L-200) |
| P4-06 connect page | #92 | met | snippets tested per client |
| P4-07 member self-service | #89 | met | own credentials only; IdP answers size-capped |
| P4-08 E2E and DAST | #96 | met | browser and ZAP workflows green on `main`; last box ticked here with the run as evidence |
| P4-09 admin security review | #100 | met | status moved from `review` to `done` here; decisions D-55 … D-58, tasks P4-34 … P4-37 |
| P4-10 admin docs | #99 | met | every `agility-bridge` command in the guides exists in the CLI (spot check) |
| P4-12 unbind identity | #95 | met | owner-only, confirmed; the named-provider variant is P4-24 |
| P4-13 `cf:setup --sign-in` | #94 | met | run on staging (below) |
| P4-14 panel benchmark | #97 | met | scenarios in the CPU benchmark |
| P4-15 panel follow-ups | #98 | met | re-enable users, token list, prefixes (inert until P4-30, D-52) |
| Chores | #86, #91, #93 | met | D1 harness, bench noise, isolation test race |
| Follow-ups | — | open | P4-24, P4-28, P4-30, P4-31, P4-34 … P4-37; none blocks Phase 5 |

Bookkeeping: every Phase 4 task is `done` or an open follow-up. The only unticked box in a done task (P4-08, "both
workflows green on main") was ticked, because the *Admin E2E and ZAP* workflow completed successfully on `main`
(run 39945836093). There are no migrations in Phase 4: `0001-init` is still the only one, so the D1 and SQLite schema is
unchanged. Every storage method has a case in the shared contract suite, which runs on memory, SQLite and D1.

## Findings

### Low

**L1 — Redaction did not know the new sign-in values** — **fixed.** Reproduced with a throwaway test: `_csrf=…`,
`{"csrf":"…"}` as text, `code_verifier=…`, `nonce=…`, `?code=…` in a callback URL, and the object keys `codeVerifier`,
`code_verifier`, `nonce`, `setupCode` and `sessionSecret` all passed through `redact` and `redactValue` unchanged. Nothing
logs them today (every Phase 4 log line carries error names, ids and counts, checked line by line), so this was a latent
gap that a future log line or error message would have turned into a leak. The key/value pattern now knows `csrf`,
`verifier`, `nonce` and `setup code`; the key list adds the PKCE, setup-code and session names; a query `code=` is cut. A
plain `code` or `state` key stays visible (error codes live under that name). Test: `packages/core/test/redact.test.ts`,
mutation-checked. Lesson L-240; THREAT_MODEL T8 names the values.

**L2 — The lessons index missed L-200** — **fixed.** Found while checking numbering; `scripts/test/numbering.test.ts` now
fails on an unlisted or repeated lesson (L-241).

**L3 — Decision numbers D-20 and D-21 exist twice (Phase 0 and Phase 1 files); D-38, D-48 … D-50, D-53 and D-54 were never
used** — **documented.** History is not renumbered; the new test pins D-20 and D-21 as the only accepted repeats so no new
one appears. The unused numbers are harmless gaps in a list that is cited by number.

## Checked and sound

- **Request isolation (L-013, L-096).** No module-level mutable state in `http-app`, `auth`, `admin-ui` or the Worker; the
  per-app caches (OIDC discovery and key source, the panel app) hold completed values only. The OIDC provider keeps no
  in-flight promise; the JWKS fetch inside the key source is jose's, which drops its pending fetch on Workers. The panel
  app is built once and holds no request data; its principal map is a `WeakMap` keyed by the request's principal.
  Sessions, login transactions and form handles live in storage, never in isolate memory (L-086).
- **Cold start.** The panel is imported dynamically on its first page; the MCP path, the admin API and health checks never
  import `@agility-bridge/admin-ui` (only a type import remains), asserted by `admin-panel-lazy.test.ts`, which also covers
  a failed import being retried. Staging confirms the lazily loaded bundle serves on Cloudflare.
- **Web-standard only.** No `node:*`, `process` or `Buffer` in `core`, `auth`, `http-app` or `admin-ui`
  (`check-runtime-imports` and a grep).
- **Logging.** Sign-in, panel and admin API errors log the error name only; the request log carries workspace, status and
  method, never a URL with a query.
- **Untrusted data in the panel.** JSX escaping everywhere; `raw()`, `html` and `dangerouslySetInnerHTML` are banned by
  `check-ui-escaping`; hostile strings are asserted in the screen tests; the CSP has no inline script or style.
- **Docs against code.** The role matrix in the docs is a test (`scripts/test/role-matrix.test.ts`); the commands the guides
  show exist in the CLI.

## Live verification (staging, 2026-10-23)

Run by the coordinator against `https://agility-bridge-staging.<subdomain>.workers.dev` at `c1334b9`:

- `pnpm cf:setup --name agility-bridge-staging` redeployed Phase 4 (nothing created); `/health` ok.
- `node scripts/staging-smoke.ts <url>`: all seven anonymous checks pass (health and headers including HSTS, version,
  uniform `401` without and with a made-up token, admin API `401`, JSON `404`, hostile `Origin` `403`); with the migrated
  device token `tools/list` lists 13 tools.
- Without any provider `/admin` and `/auth/*` answer `404`, as documented. Then `pnpm cf:setup --name
  agility-bridge-staging --sign-in` (environment mode, a placeholder GitHub client, no real GitHub app) printed the
  redirect URI `/auth/callback/github` and created the `AB_GITHUB_CLIENT_SECRET` secret through stdin.
- With it: `/admin` and `/admin/users` answer `303` to `/auth/login?next=%2Fadmin` and `%2Fadmin%2Fusers`; `/auth/login`
  answers `200` with the panel CSP (`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src
  'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; require-trusted-types-for 'script'`); `/auth/setup`
  answers `200` with the setup CSP (no `form-action`, D-35); `GET /auth/login/github` answers `302` to
  `github.com/login/oauth/authorize` with the right `redirect_uri` and scopes and sets `__Host-ab_login` (`Path=/`,
  `Max-Age=600`, `HttpOnly`, `SameSite=Lax`, `Secure`).

**Owner steps still open** (listed under *Owner steps* in [pending decisions](../pending-decisions/phase-4.md)): replace the
placeholder GitHub client on staging with a real provider (`pnpm cf:setup --name agility-bridge-staging --sign-in`), sign
in for real and record it in [RESEARCH.md §9](../RESEARCH.md#9-admin-sign-in-providers-p4-01), walk the panel on a phone,
and run the clients over HTTPS.

## Go / no-go for Phase 5

**Go**, recommended, with the real sign-in as a parallel owner step: Phase 5 (OAuth for hosted clients) reuses the identity
providers, the session and the consent pages. Recorded as D-59 in [pending decisions](../pending-decisions/phase-4.md).
