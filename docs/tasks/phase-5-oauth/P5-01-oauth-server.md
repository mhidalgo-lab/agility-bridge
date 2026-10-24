---
id: P5-01
title: OAuth 2.1 authorization server
phase: 5
status: in-progress
priority: high
depends_on: [P4-11]
adr: ["0009"]
lessons: [L-013, L-073, L-086, L-094, L-096, L-121, L-164, L-240]
owner: "claude-agent"
---

# P5-01 — OAuth 2.1 authorization server

> Refined 2026-10-24 (tasks/README rule 7), after P0-08 (`spikes/oauth/RESULTS.md`) and relic-bridge's P5-01 and its
> Phase 5 review.

## Goal
agility-bridge issues OAuth tokens for MCP clients, with all state in shared storage, and accepts them on
`/w/{slug}/mcp` through the same resolver as device tokens. The interactive step (sign-in, consent), client
registration hardening, protected resource metadata, refresh reuse and abuse controls are the sibling tasks; this one
builds the server they plug into.

## Scope
- **Provider integration** chosen in P0-08: `@cloudflare/workers-oauth-provider` 1.2.3, pinned exactly (1.2.4 is under
  the 3-day release age), run unmodified in `packages/http-app/src/oauth/` on Node and Workers, imported lazily so
  device-token-only deployments never load it. Node and the bundles alias `cloudflare:workers` to a 10-line shim (the
  provider uses it for `instanceof` checks only).
- **State in `kv` on both runtimes** (SQLite on Node, D1 on Workers) through a KV-namespace adapter under the `oauth:`
  key prefix: clients, grants and token records. No isolate or process memory holds request or authorization state (L-086,
  L-096, L-013); the only cache is the provider objects per set of resources, which hold configuration only.
- **Endpoints** (unauthenticated, per-IP limited with the existing `beforeAuth` hook, bodies capped at 16 KiB):
  `GET /.well-known/oauth-authorization-server` (RFC 8414), `GET /oauth/authorize`, `POST /oauth/token` (code and refresh
  grants, RFC 7009 revocation), `POST /oauth/register` (RFC 7591, a compatibility path whose limits are P5-03). The
  issuer is the configured public URL (`AB_PUBLIC_URL`), never the `Host` header.
- **Authorization request**: exactly one `resource`, one of our `{issuer}/w/{slug}/mcp` URLs (RFC 8707) — the workspace
  being asked for; no parameter twice; `response_type=code`; PKCE `S256` for every client (public or confidential,
  `plain` and a missing challenge refused); client and redirect URI validated by the provider (exact match) before any
  redirect; every authorization response carries `iss` (RFC 9207). Scopes: `mcp:read` and `offline_access`.
- **Token request**: `application/x-www-form-urlencoded` only, no parameter twice, `code_verifier` 43-128 unreserved
  characters (RFC 7636 §4.1) checked before the code is consumed; `resource`, when sent, must be one of ours and the
  grant's own (refresh cannot retarget). Access tokens 1 h, refresh tokens 30 d, both settable.
- **Codes are single use under concurrency**: approving writes a marker that the token endpoint consumes with the
  atomic `kv.take` before the provider sees the code (the provider's own check is read-then-write, L-073). A replayed
  or raced code is refused and, when it really was issued for its grant, revokes the grant (a tombstone written first,
  so a request in flight cannot bring the device back).
- **Consent seam**: the interactive step is an `OAuthConsentHandler` option (`consent`), shipped by P5-04. `approve()`
  re-runs the access resolver for the requested workspace before any code is minted (grant of that user and workspace,
  live, usable credential; service grants and other users' grants refused) and binds the token **props** to workspace,
  user, grant and client. Until P5-04 the hosts refuse `AB_OAUTH=on` at start with a message naming that task, so
  OAuth cannot be turned on in a deployment with no way to approve; tests inject a stand-in.
- **Tokens and secrets at rest**: authorization codes, access tokens and refresh tokens are 256-bit opaque values stored
  by their SHA-256 only; grant props (workspace, user, grant, client ids) are encrypted by the provider with a key
  wrapped under each token, so neither a database copy nor the master key opens them (ADR-0009). Token-family metadata
  holds nothing secret and no personal data (T25). `redact()` learns the token shape in the same PR (L-240).
- **MCP route**: a device token takes the existing path unchanged; any other bearer is validated by the provider for
  this workspace's resource only, its props are cross-checked (workspace, user, client, scope), and the grant goes
  through `resolveAccess` as an `oauth` principal (same cache keyed by token hash and slug, same hooks, same audit and
  rate limits keyed by the OAuth device `oauth_<grant id>`, same single 401 for every denial, no Agility request on
  denial). Audit rows carry the OAuth client id.
- **Token issuance re-checks access** (code exchange and refresh): the resolver runs again for the grant's workspace;
  a refusal is `invalid_grant`, revokes the device and writes an `oauth.token.refused` row; access and refresh
  lifetimes are capped at the grant's expiry.
- **Settings** (both hosts, `parseServerSettings`): `AB_OAUTH` (`off` default | `on`), `AB_OAUTH_ACCESS_TTL` (default
  `1h`, 60 s-24 h), `AB_OAUTH_REFRESH_TTL` (default `30d`, 1 h-365 d; not shorter than the access lifetime). `on` needs
  `AB_PUBLIC_URL`.
- **Audit**: `oauth.authorize` (approved, denied), `oauth.token.issued`, `oauth.token.refused`, `oauth.code.replayed`,
  `oauth.token.revoked`, as `auth` rows with user, grant, workspace, client and device ids; never a code, token or
  verifier.

## Acceptance criteria
- [ ] Conformance tests with SDK-shaped clients (the MCP TypeScript SDK's own OAuth client functions: discovery
  metadata, registration, authorization URL, code exchange, refresh) on Node (memory storage and SQLite) and workerd (D1),
  from one shared suite; replayed and concurrently redeemed codes yield at most one token set.
- [ ] Refused: PKCE `plain` and missing, wrong verifier, wrong redirect URI, wrong client, wrong or unknown workspace
  (`resource`), expired code, a repeated parameter, a JSON token request, an out-of-range verifier; refresh cannot retarget.
- [ ] Token props bound to workspace, user, grant and client; a token for workspace A fails at B; a revoked grant, a
  disabled user, another user's grant, a service grant and an expired grant all answer the generic `401` with no Agility
  request and no tool data (negative authorization, L-121); device tokens keep working with OAuth on.
- [ ] Codes, access and refresh tokens are stored hash-only and grant properties encrypted; a scan of storage (kv, audit,
  a SQLite file copy), logs and audit finds no plaintext bearer value (ADR-0009).
- [ ] `AB_OAUTH` settings parsed and checked on both hosts; `on` without `AB_PUBLIC_URL`, or without the consent screen,
  refuses to start; off by default.
- [ ] Security tests are mutation-checked (L-121), recorded under Outcome.
- [ ] `docs/dev/oauth.md` (new), THREAT_MODEL T9 and T25, ARCHITECTURE, RESEARCH, the configuration reference, a
  changeset, and new lessons are done.

## Security notes
THREAT_MODEL T9, T25 (T2, T8, T15, T19, T21 touched).

## Lessons applied
- L-073 — One-time state is consumed atomically.
- L-086 — OAuth state lives in shared storage.
- L-094 — Follow the OAuth details clients rely on.
- L-096 — Never share in-flight I/O between requests on Workers.
- L-121 — Negative authorization is first-class.
- L-164 — The OAuth provider keeps one refresh token per grant (the reuse window is P5-05).
- L-240 — A new secret adds its redaction forms in the same PR.

## Docs to update
- docs/dev/oauth.md (new)
- docs/ARCHITECTURE.md, docs/THREAT_MODEL.md, docs/RESEARCH.md, docs/guide/configuration.md

## Out of scope
- Per-workspace protected resource metadata and the `resource_metadata` challenge (P5-02).
- Client ID Metadata Documents and the hardening, caps and expiry of dynamic registration (P5-03).
- The sign-in and consent screen, remembered consent, device labels, write consent (P5-04); the hosts keep `AB_OAUTH=on`
  refused until it exists.
- Refresh rotation families, the reuse window and device caps (P5-05); connected-apps administration (P5-08); abuse
  controls beyond the per-IP limit (P5-09).
- Anything not listed under Scope.
