---
id: P4-01
title: Identity providers and owner bootstrap
phase: 4
status: done
priority: high
depends_on: [P3-11]
adr: ["0009"]
lessons: [L-085, L-091, L-092, L-184, L-185, L-186, L-187, L-188, L-189]
owner: "claude-agent"
---

# P4-01 — Identity providers and owner bootstrap

## Goal
Admins and members sign in with Google, GitHub, Cloudflare Access or any OIDC provider; nobody gets in by default.
This task ends at a **verified, allowed user record**. Turning that into a browser session (cookie, CSRF, roles in the
panel) is P4-02, which plugs into the `onLogin` seam defined here; until then a finished sign-in shows "Signed in as …".

## Scope
- **Providers** (`packages/auth/src/identity`, web-standard only, ADR-0004), all behind one `IdentityProvider`
  contract that yields a `VerifiedIdentity { idp, subject, email, emailVerified: true, displayName, orgs? }`:
  - *Redirect providers* (authorization code + PKCE S256 + `state`; OIDC ones also `nonce`): generic **OIDC** by
    discovery (exact issuer match, https endpoints, RFC 9207 `iss`, `email_verified` required), **Google** (preset
    with the `hd` request hint and the `hd` *claim* enforced) and **GitHub** (OAuth app: numeric user id as subject,
    the primary and verified email, optional organization membership, the access token revoked after the lookup).
  - *Header provider*: **Cloudflare Access**, the `Cf-Access-Jwt-Assertion` JWT verified against the team's JWKS and
    the application's AUD tag (service tokens without an email are refused; the `CF_Authorization` cookie is ignored).
  - JWT verification on `jose` (asymmetric algorithms only, 60 s skew, JWKS cached per provider and refetched on an
    unknown `kid`). Every provider call (discovery, JWKS, token, userinfo, GitHub API) goes through an **injected
    `fetch`** with a timeout, no redirects, a 256 KiB cap (the JWKS too) and JSON only. These are not Agility requests:
    no instance budget, circuit breaker or Agility limiter applies. On Node the default fetch refuses non-public
    addresses at connect time (`AB_IDENTITY_PRIVATE_ADDRESSES=allow` for an IdP on a private network); on Workers the
    platform does.
- **Sign-in transactions** in `kv` (never isolate memory): keyed by the SHA-256 of `state`, 10 minute TTL, holding the
  PKCE verifier, nonce, provider, optional setup-link hash, the validated `next` path and the hash of a browser-binding
  cookie (`__Host-ab_login`, plain `ab_login` on http loopback; a name sent twice is no cookie). Consumed exactly once
  with `kv.take`; a transaction of provider A at the callback of provider B is refused.
- **One identity per user** (`(idp, subject)`), mapped by `resolveLoginUser`: a bound user signs in; a verified email
  binds only a user with **no identity yet** (compare-and-set `users.bind`, so two concurrent first sign-ins cannot both
  win); a user bound elsewhere is an `identity_conflict`; disabled users are refused; emails are printable ASCII only.
  Unknown identities are **denied by default**: they get in only through an allowlist (exact email, email domain,
  active GitHub organization) **and** `AB_LOGIN_AUTO_PROVISION=member|admin` (never `owner`).
- **Owner setup link**: `POST /api/admin/v1/setup-links` (owner or break-glass token) and `agility-bridge setup-link`
  issue `https://<public url>/auth/setup#ab_setup_<256 bit>`. The code lives in the URL **fragment** (never sent to the
  server, never in an access log or `Referer`); the page's script (served by the app, no inline script) moves it into a
  POST body, which starts the sign-in; without scripts the code can be pasted. Single use (consumed atomically by the
  completed callback only, so a prefetch or a failed attempt does not burn it twice), expires (default 60 minutes, at
  most 7 days), stored only as a hash, and always means *owner*. It cannot be combined with a disabled user or an
  identity conflict.
- **Redirects**: `next` is validated after URL parsing (dot segments, backslashes, encoded slashes, scheme-relative,
  control characters) and again where it is emitted; the callback URL is built from `AB_PUBLIC_URL` only, never `Host`.
- **Routes** (only when a provider is configured): `GET /auth/login`, `GET /auth/login/:provider`,
  `GET /auth/callback/:provider`, `GET /auth/cf-access`, `GET|POST /auth/setup`, `GET /auth/setup.js`. Sign-in pages
  carry their own strict CSP (no inline script or style) and `no-store`. One generic failure page with the request id.
- **Audit and logs**: `auth` rows `login.ok` / `login.denied` (provider, stable reason, outcome, a keyed
  `identityHash` of `(idp, subject)`, never the subject, email, code, token or setup code) and `setup_link.create`
  (admin row). Logs go to stderr, structured and redacted (`ab_setup_…` joins the redaction patterns).
- **Limits**: a per-IP sign-in rule (`AB_RATE_LIMIT_SIGN_IN`, default 60 per 5 minutes) in front of every `/auth/*`
  route, since each sign-in start writes a `kv` row and may call the IdP.
- **Settings** (shared by `serve` and the Worker through `parseServerSettings`, bad values are a `SettingsError` that
  names the variable, never the value): `AB_GOOGLE_CLIENT_ID`/`_SECRET`, `AB_GOOGLE_HOSTED_DOMAIN`,
  `AB_GITHUB_CLIENT_ID`/`_SECRET`, `AB_OIDC_ISSUER`/`_CLIENT_ID`/`_CLIENT_SECRET`/`_NAME`/`_LABEL`/`_SCOPES`,
  `AB_CF_ACCESS_TEAM`/`_AUD`, `AB_LOGIN_ALLOW_EMAILS`/`_DOMAINS`/`_GITHUB_ORGS`, `AB_LOGIN_AUTO_PROVISION`
  (`off` default), `AB_RATE_LIMIT_SIGN_IN`, Node: `AB_IDENTITY_PRIVATE_ADDRESSES`. Client secrets are environment or
  Worker secrets (and `*_CLIENT_SECRET_FILE`, 0600, on Node), never flags or tool arguments. Boot warnings: an
  allowlist without auto-provisioning (only existing users can sign in), auto-provisioning without an allowlist,
  `admin` auto-provisioning, GitHub orgs without GitHub.

## Acceptance criteria
- [x] Each provider has a happy-path test and refusals against a local fake IdP (self-generated JWKS, no network): wrong
  `iss`, `aud`, `azp`, `nonce`, signature, `alg: none`, an HS256 token signed with the public key, expired, JWKS refetch
  on key rotation, unverified or missing email, Google `hd` mismatch, GitHub without a verified primary email, pending
  organization invitation, Cloudflare Access wrong AUD / missing header / service token.
- [x] State replay, a foreign or missing binding cookie, a provider mix-up and an RFC 9207 `iss` mismatch are refused;
  the transaction is consumed once under parallel callbacks.
- [x] Open-redirect attempts (`//host`, `/\host`, `/.//host`, `/a/..//host`, `/%2e//host`, absolute and `javascript:`
  URLs, CRLF, control characters) never reach a `Location` header.
- [x] Identity conflicts: an email already bound to another identity is refused; two concurrent first sign-ins give
  one success and one `identity_conflict` (storage `bind` on memory and SQLite, and D1 on workerd); a non-ASCII (Kelvin
  sign) email cannot claim an ASCII row.
- [x] Allowlist and auto-provision combinations (`off` / `member` / `admin` × email / domain / org / none) behave as
  documented; `owner` is never auto-provisioned.
- [x] Setup link: single use, expires, makes the identity owner, is refused for disabled users and conflicts, never
  appears in a URL the server sees, a log line, an audit row or a response, and is owner-only to create.
- [x] Negative authorization tests: a refused sign-in creates no user, sends no session, and the IdP is not called for
  malformed callbacks; provider fetches are bounded (timeout, size cap, redirect refusal).
- [x] Key security tests are mutation-checked (the fix reverted, the test fails; L-121), recorded in the PR.
- [x] Settings are parsed on both hosts, a bad value names its variable, and the sign-in routes boot on workerd.
- [x] `docs/guide/identity-providers.md`, THREAT_MODEL T11 and T14, RESEARCH.md and the configuration reference are
  updated; the commands in the guide run (L-133); a changeset is included.
- [x] Real Google, GitHub and Cloudflare Access applications are **not** exercised (they need OAuth apps the autonomous
  run may not create); the steps are in `docs/pending-decisions/phase-4.md`.

## Outcome
- Built as scoped. Two additions beyond the first draft: the PKCE verifier and nonce are *derived* from `state` with a
  new master-key purpose (`login`) so the transaction row holds no recoverable secret (ADR-0009), and `users.bind` is a
  new storage operation (compare-and-set, contract-tested on memory, SQLite and D1).
- Sessions were not needed: sign-in ends in `onLogin` (default: a page naming the user).
- Mutation checks (L-121): 39 deliberate reversions of the security fixes (redirect re-check, atomic `take`, binding
  cookie, provider mix-up, nonce, audience, issuer, `azp`, `hd`, verified email, GitHub primary and organization state
  and revocation, JWKS and IdP size caps, redirects, ASCII emails, Access AUD and service tokens, RFC 9207, exact
  issuer, compare-and-set bind on SQL and memory, setup link single use, owner and recent-auth guards, cross-site setup
  form, duplicate cookies, fragment, sign-in limit, auto-provision, cookie flags, redaction, CSP) each fail a test;
  two survivors were examined: the setup-link expiry check in code is shadowed by the `kv` expiry (equivalent mutant,
  kept as defence in depth) and a constant verifier was not caught until a test required distinct challenges per login.
- Follow-ups: P4-12 (unbind), P4-13 (`cf:setup` sign-in prompts); decisions D-29 – D-32 in
  `docs/pending-decisions/phase-4.md`.

## Security notes
THREAT_MODEL T11 (provider fetches), T14 (account takeover), T8 (no secrets in logs and audit), T24 (callback URL from
configuration, never `Host`).

## Lessons applied
- L-085 — One-time secrets never travel in URLs.
- L-091 — Validate redirect targets after parsing.
- L-092 — One identity per user.
- L-184 – L-189 — Added by this task from the relic-bridge Phase 4 reviews (ASCII-only emails, compare-and-set
  binding, one size cap for every IdP answer, a budget for unauthenticated sign-in starts, tokens dropped after one
  lookup, duplicate cookies are no cookie).

## Docs to update
- docs/guide/identity-providers.md (new)
- docs/guide/configuration.md, docs/THREAT_MODEL.md, docs/RESEARCH.md, docs/reference/cli.md and
  docs/reference/admin-api.md (generated)

## Out of scope
- Sessions, CSRF, roles in the panel, re-authentication (P4-02); the admin UI (P4-03+): sign-in pages here are minimal
  server-rendered HTML that P4-03 restyles.
- MCP-client OAuth (Phase 5).
- Unbinding or moving a user to another identity on purpose, several identities per user, `cf:setup` prompts for
  provider secrets (new tasks if wanted).
