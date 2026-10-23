---
id: P4-08
title: Browser E2E and DAST baseline
phase: 4
status: done
priority: medium
depends_on: [P4-04, P4-05, P4-07]
lessons: [L-121, L-123, L-126, L-194, L-195, L-215, L-216, L-217, L-218, L-219]
owner: "claude-agent"
---

# P4-08 — Browser E2E and DAST baseline

## Goal
Catch what unit and in-process tests cannot in the panel: the Content Security Policy, Trusted Types, `form-action` and
framing as a real browser enforces them, cookies with their `__Host-` names and attributes over https, forged requests
from another origin, logout and re-authentication in a browser, one-time pages on the back button, layout at 320 px,
accessibility as laid out, and what an automated passive scanner (OWASP ZAP) sees on the running server.

P4-02, P4-03, P4-04 and P4-07 each list "a real browser" under *Not exercised*; this task is where those checks run.

## Refinement (2026-10-23)

Ported and adapted from relic-bridge (P4-11 browser E2E, P4-12 ZAP baseline, P4-24 scheduling), same owner, Apache-2.0.
Differences that matter here: the panel has more screens (instances, workspaces, grants, member self-service, audit viewer),
sign-in is OpenID Connect against a fake provider on loopback (the setup link, then "Continue with …"), the instance is the
synthetic Agility of `scripts/fixture-agility.ts` (reached with `AB_ALLOW_HTTP_INSTANCES=on`, P2-19), and
the CI jobs run on pull requests that touch the panel, not only weekly. The connect page (P4-06) lands in a parallel PR and
adds its screen to the list in `e2e/admin.spec.ts` ("every screen with data"); this task covers every screen merged
before it.

## Scope

**Harness (`e2e/`, outside `pnpm test`, own `tsconfig`, part of `pnpm typecheck`)**
- `server.ts`: the built `agility-bridge serve` (own `tsdown` output, never the published `dist`) on a temporary SQLite
  database, random master key and admin token, the fake OIDC provider (`idp.ts`, the P4-01 fake behind a loopback HTTP server
  with a browser-facing `/authorize`, `auth_time`, and a record of every authorization request), and the synthetic Agility as
  a child process. `secure: true` adds a TLS proxy with a throw-away self-signed certificate (made with `openssl` at run
  time), so the server runs with an `https://` public address. Helpers: `api()` (admin token, for seeding and checking
  state only), `seed()`, `ageSessions()` (moves the stored sign-in time back, to cross the 10-minute window without waiting).
- `watch.ts`: every page load is watched for `securitypolicyviolation` events, console errors and warnings, uncaught
  errors and failed requests; any one fails the test (a deliberate 403/422 is declared with `expectStatus`).
- Projects: `desktop` (1280 px) and `mobile-320` (Pixel 5 emulation at 320 px) in Chromium; `AB_E2E_BROWSERS=all` adds
  Firefox and WebKit for the smoke spec.

**Specs**
- `admin.spec.ts` (both viewports): the setup link (once; a spent link signs nobody in), sign-in, instance, shared
  credential (token never shown again), workspace, grant, device tokens (shown once, copy button, reload and back do not show
  or re-create it, the token opens the MCP endpoint, a revoked one stops), invite a member, the member's own sign-in with a
  personal token, 403 pages for every administrator screen, the audit viewer (own rows only for a member, filters, CSV
  download) and usage, rename, check, edit, disable and enable, the last-owner rule, and every screen with data in light and
  dark: no horizontal scroll and no WCAG 2.1 A/AA violation (axe-core in the real layout, contrast included).
- `security.spec.ts` (desktop): the exact CSP and companion headers on every page; Trusted Types, `img-src` and `style-src`
  enforced by the browser; `form-action` blocks a form re-pointed at another origin; the panel in another site's frame stays
  empty; forged form posts, scripted posts and image requests from a same-site other origin and from another site change
  nothing, while a plain link from another site lands on the panel; the session cookie (`HttpOnly`, `SameSite=Lax`, not in
  `document.cookie`), logout (cookie cleared, `Clear-Site-Data`, the copied cookie is dead, back button), sign out
  everywhere, signed-out visitors and a forged `next`, a provider that refuses or a person nobody invited, and
  re-authentication (a stale sign-in asks again, nothing changes, another person at the provider is refused, `prompt=login`
  and `max_age=0` are sent, the same person continues).
- `secure.spec.ts` (desktop, https): `__Host-` names, `Secure`, no `Domain`, HSTS, `Clear-Site-Data`.
- `smoke.spec.ts`: the shortest path, also in Firefox and WebKit when asked.

**DAST (`e2e/zap.ts`, `pnpm scan:zap`)**
- OWASP ZAP baseline (passive) scans from the official image pinned by digest, against the same throw-away server only:
  `/auth/login` signed out, `/admin` spidered with the owner's session on a database with an instance, credential, workspace,
  member, grant and device token, and the admin API's OpenAPI document with the admin token (passive, `-S`). Docker Desktop
  gets a loopback relay. The reports are checked for any secret value (they are deleted when one is found).
- `.zap/rules.tsv` documents every ignored rule with a reason; any other alert of risk Medium or High fails the run.

**CI** (no required check, no secret, read-only token, actions pinned by SHA)
- `.github/workflows/admin-e2e.yml`: a Playwright job and a ZAP job, on pull requests that touch the panel, sign-in, the
  admin API, the CLI or these files, on pushes to `main` with the same paths, weekly (Monday) and on demand. Reports and
  traces are uploaded as artifacts. Explicit step and job timeouts.

## Acceptance criteria
- [x] Browser E2E covers every screen delivered by P4-04, P4-05 and P4-07 (the connect page of P4-06 adds itself), at 1280 px
      and 320 px, with zero CSP/Trusted Types violations, console errors and axe violations.
- [x] The CSP, Trusted Types, `form-action`, framing, cross-origin forgery, cookie, `__Host-`, `Clear-Site-Data`,
      one-time-page, logout and re-authentication behaviours listed in the *Not exercised* notes of P4-02 and P4-03 are
      asserted in a real browser.
- [x] A ZAP baseline scan runs from a digest-pinned image against the local server, with a committed rules file in which
      every ignored rule has a reason; a new Medium or High alert fails it.
- [x] Browser and ZAP jobs exist in CI with explicit timeouts, artifacts and no secrets; not required checks (an owner step
      says whether to require them).
- [x] Both workflows are green on `main` (ticked in P4-11: the *Admin E2E and ZAP* run 39945836093 and CI succeeded on `main`).
- [x] `docs/dev/testing.md` describes how to run both; defects the browser found are fixed with regression tests or become
      task files.

## Security notes
THREAT_MODEL T13 (XSS, CSRF, clickjacking), T14 (sessions). The fake provider, tokens and certificates are generated at
run time; nothing is committed that gitleaks would flag. ZAP is pointed at loopback only and runs passive rules only.

## Lessons applied
- L-121 — Negative tests that fail when the fix is reverted.
- L-123 — Make property tests meaningful and deterministic (the specs use no sleeps as assertions; waits are for events).
- L-126 — Browser E2E and a DAST scan find what unit tests miss.
- L-194, L-195 — The CSP is compared against a literal; the panel's headers.

## Docs to update
- docs/dev/testing.md, docs/dev/admin-ui.md, docs/guide/admin-panel.md (verification note), CONTRIBUTING.md,
  docs/pending-decisions/phase-4.md

## Out of scope
- Screenshots for the guide (a follow-up if wanted), a real identity provider (owner step), load testing, active ZAP
  scans, the Cloudflare Worker in a browser (the staging smoke covers the Worker over HTTP).

## Outcome

- **Built**: `e2e/` (harness, fake OIDC provider with a browser-facing `/authorize`, TLS proxy mode, page watcher, axe helper,
  four specs), `pnpm test:e2e`, `pnpm scan:zap` (`e2e/zap.ts`, `.zap/rules.tsv`, ZAP image pinned by digest), the
  `Admin E2E and ZAP` workflow, docs (testing, admin-ui, admin guide, CONTRIBUTING, THREAT_MODEL T13), lessons L-215 to L-219,
  decisions D-43 and D-44, changeset.
- **Ran locally**: all 24 Playwright tests in Chromium (desktop 17, mobile 320 px 7) and the full ZAP scan (login, admin
  with data, admin API with 45 generated requests): no unreviewed Medium or High alert. Not run: Firefox and WebKit (their
  browsers are not installed here; `AB_E2E_BROWSERS=all` runs the smoke spec in them), the CI jobs themselves (only after
  the push), and "green on `main`" (after the merge).
- **Defects found and fixed**: a sideways-scrolling table was not keyboard reachable (axe `scrollable-region-focusable`;
  now a focusable named `<section>`, unit test); an empty JSON body on the admin API answered `500` instead of `400`
  (`onError` maps the validator's 400; regression test fails on the old code). The browser also confirmed the CSP, Trusted
  Types, `form-action`, framing, `__Host-` cookies, `Clear-Site-Data`, same-site and cross-site forgery refusals, one-time
  token pages and re-authentication behave as specified; the ZAP "SQL disclosure" is a false positive on prose (ignored,
  explained).
- **relic-bridge findings folded in**: the harness and ZAP script (relay for Docker Desktop, secret scan of reports, digest
  pin), `Origin: null` is covered by every form flow, CSP assertions against a literal, console and CSP watching on every page.
  Added beyond relic: axe, https mode, same-site forger, re-authentication flow, member flow, light and dark.
- **Notes**: the connect page (P4-06) adds itself to the "every screen with data" list. Screenshots for the guide are not part
  of this task. Specs run serially per file and share a server, so they are order dependent by design (documented).

