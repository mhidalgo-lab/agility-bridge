# OAuth 2.1 server (developer guide)

Status: P5-01 (server), P5-02 (resource metadata) and P5-04 (sign-in, consent, devices) built; **off by default**.
`AB_OAUTH=on` needs `AB_PUBLIC_URL` and a sign-in provider ([D-60](../pending-decisions/phase-5.md), superseded). Decisions: [ADR-0009](../adr/0009-authentication.md); evidence:
[spikes/oauth](../../spikes/oauth/RESULTS.md), [RESEARCH §4](../RESEARCH.md#4-oauth-21-for-mcp).

agility-bridge is its own authorization server for MCP clients. It runs `@cloudflare/workers-oauth-provider` (1.2.3,
pinned) unmodified inside `packages/http-app/src/oauth/`, on Node and on Workers, with all state in the storage `kv` table.

## Shape

```
client ──GET /.well-known/oauth-authorization-server──▶ metadata (RFC 8414, no workspace list)
client ──POST /w/{slug}/mcp (no token)──▶ 401, WWW-Authenticate: Bearer realm=…, resource_metadata="…/.well-known/oauth-protected-resource/w/{slug}/mcp", scope="mcp:read"
client ──GET /.well-known/oauth-protected-resource/w/{slug}/mcp──▶ RFC 9728 document (resource, authorization_servers, scopes)
client ──POST /oauth/register──▶ provider (RFC 7591)                         [P5-03 hardens]
client ──GET /oauth/authorize?resource=…/w/{slug}/mcp&code_challenge=…──▶ prepare()
        validates: one resource of ours, no repeated parameter, client, exact redirect URI, PKCE S256, scope
        └─▶ consent handler (P5-04): sign in, page, handle           (oauth/consent.ts)
client ──(browser)──POST /oauth/consent?<same query>  session, Origin, CSRF, single-use handle bound to the request
            └─▶ api.approve({ userId, grantId, label })  ── resolveAccess(oauth principal) ──▶ code + marker, redirect with iss
client ──POST /oauth/token (form)──▶ verifier format ▶ atomic kv.take(code marker) ▶ provider ▶ issuance check ▶ tokens
client ──POST /w/{slug}/mcp  Authorization: Bearer <access token>──▶ provider.validateToken(resource) ▶ props cross-check
        ▶ resolveAccess(oauth principal) ▶ the same MCP path as a device token
```

Files: `oauth/server.ts` (runtime), `oauth/consent.ts` (built-in consent screen), `oauth/kv-namespace.ts` (provider KV over `storage.kv`), `oauth/settings.ts`
(`AB_OAUTH*`), `oauth/cloudflare-workers-shim.ts` (Node stand-in for `cloudflare:workers`), routes and the MCP-route hook in
`app.ts`, `AuditWriter.oauth` in `audit.ts`. The provider is imported lazily; the CLI bundle aliases `cloudflare:workers`
to the shim (the provider uses `WorkerEntrypoint` for `instanceof` only), Workers use the real module.

## What is stored where

| Key (`kv`) | Holds | Secret at rest |
|---|---|---|
| `oauth:client:<id>` | registered client (redirect URIs, name, auth method) | secret hashed by the provider |
| `oauth:grant:<user>:<grant>` | device authorization: hashes of the code and refresh tokens, wrapped keys, **encrypted props**, metadata `{grant, workspace, label?}`: the access grant id, the workspace id and the device name the person typed (P5-04) | hashes and ciphertext only |
| `oauth:token:<user>:<grant>:<sha256>` | access-token record | hash only |
| `oauth-code:<sha256(code)>` | single-use marker, 10 min | hash only |
| `oauth-revoked:<user>:<grant>` | tombstone of a revoked device (refresh lifetime) | none |
| `oauth-consent:<user>:<expiry>-<random>` | consent form handle, 15 min: the SHA-256 of the exact authorization request the page showed | none (a hash of public request values) |

Tokens are `<user id>:<grant id>:<secret>` (user id is ours, `usr_…`; no email anywhere, T25). Props are
`{grantId, workspaceId, workspaceSlug, userId, clientId}`, AES-GCM encrypted with a per-grant key wrapped under the code,
the refresh token and each access token. No keyring purpose is used (D-62). `redact()` knows the token shape (L-240).
Tests scan `kv`, audit rows, logs and a SQLite file copy for codes, tokens and verifiers after full flows.

## Rules the code enforces

- Issuer is `AB_PUBLIC_URL`, never `Host`. Resources are exactly `{issuer}/w/{slug}/mcp` (scheme and host case-folded in
  ASCII, everything else exact; trailing slash, query, extra path, encoded slash refused).
- Authorization: PKCE `S256` for every client; one `resource`; `iss` on every authorization response; errors before the
  redirect URI is validated are JSON `400`, never redirects.
- Token endpoint: form-encoded only, no repeated parameter, `code_verifier` 43-128 unreserved characters (checked **before**
  the code is consumed), `resource` if present must be ours and the grant's own.
- Codes: `kv.take` on the marker (atomic on memory, SQLite and D1) before the provider sees the code; a replay revokes the
  grant it was issued for (tombstone first) and writes `oauth.code.replayed`.
- Issuance (code and refresh): `resolveAccess` again; a refusal is `invalid_grant`, revokes the device, writes
  `oauth.token.refused`; lifetimes are capped at the grant's expiry, and under a minute left refuses.
- MCP route: OAuth tokens (shape `user:grant:secret`) are tried only when OAuth is on; a device token never matches that
  shape. Every failure is the one `401`. The access cache (keyed by token hash and slug, never past the token's expiry)
  is cleared on RFC 7009 revocation.
- Discovery (P5-02): `GET /.well-known/oauth-protected-resource/w/{slug}/mcp` answers `{resource, authorization_servers:
  [issuer], scopes_supported: ["mcp:read"], bearer_methods_supported: ["header"]}` for **every** slug of valid syntax:
  known, unknown or disabled look the same, because the MCP route's `401` already is one answer and the document must not
  turn into a workspace probe (T19, D-64). An invalid slug, the root document and every other method are the app's `404`.
  The `401` challenge of `/w/{slug}/mcp` with OAuth on is a function of the slug's syntax only (`Bearer realm="agility-bridge",
  resource_metadata="…", scope="mcp:read"`; no `error=`, for device tokens and OAuth tokens alike); OAuth off keeps the
  plain `Bearer`. Both are built from the configured public URL. The document is under the app-wide `no-store` policy
  and the per-IP `beforeAuth` limit (D-65).
- No write scope yet: tokens carry `mcp:read` (+ `offline_access`); the `oauth` principal's `writeScope` is false.

## Sign-in and consent (P5-04)

`createConsentScreen` (`oauth/consent.ts`) is the `consent` seam's built-in handler, wired by `createHttpApp` whenever
`oauth.consent` is not injected (it needs `identity`). The views, the CSP and the error pages are the panel's
(`@agility-bridge/admin-ui`, loaded lazily on the first consent request, never by an MCP request).

- **`GET /oauth/authorize`** (after `prepare()` validated it): only top-level navigations from other sites; `prompt=none`
  is answered with `login_required` / `consent_required` (`invalid_request` when mixed with another value) at the validated
  redirect URI and never shows a page; signed out → `303 /auth/login?next=<the authorize URL>` (the sign-in validates `next`
  after parsing, L-091; longer than 2048 characters is a 400 page); signed in → the consent page.
- **The page** names the app (untrusted `client_name`, escaped, **always "not verified"**), the **redirect host**, a
  loopback warning, the workspace (the `resource`) and the person's own live grants on it (`api.grants()`: each passes the
  access resolver as an `oauth` principal), a device name field, Allow and Deny. No live grant, or an unknown workspace:
  the same refusal text and only Deny. `Content-Security-Policy` is the panel's plus the redirect URI's origin in
  `form-action` (L-249); `frame-ancestors 'none'`, `no-store`, no inline script or style.
- **`POST /oauth/consent?<authorize query>`**: session, fetch metadata and `Origin`, urlencoded ≤ 16 KiB, exactly one
  `_csrf`, then `prepare()` again from the form's own URL and the **handle**: `kv.take` of
  `oauth-consent:<user>:<handle>` must return the hash of this exact request (client, redirect URI, PKCE challenge and
  method, resource, scope, state, response type). The handle is spent whatever happens; a replayed, swapped, cross-user,
  invented or expired form shows a 409 page and writes `oauth.consent.refused` (`handle_used_or_expired`,
  `handle_mismatch`, `grant_not_offered`). Approve needs one of the person's own offered grants, then `approve()`;
  Deny is `api.deny()`. The answer is a `303` to the validated redirect URI (an `http://[::1]` target gets a same-origin
  page with `Refresh` instead, L-249).
- **Not built:** remembered consent (D-66), write consent (Phase 7), CIMD identification (P5-03).

### Phishing review (T10)

| Attack | What stops it |
|---|---|
| An app named "Claude" or "Your IT department" | the name is escaped text with a "not verified" badge on every page; registration is open, so nothing here ever says "verified" |
| A look-alike redirect host | the redirect host is its own prominent line; the redirect URI is the registered one (exact match, validated by the provider) |
| A local program pretending to be a site | a loopback redirect is called "a program on the computer that opened this page" |
| Markup or script in the name | Hono JSX escaping only (`check-ui-escaping.ts`); no inline script or style at all; tested with hostile and 120-character names at 320 px |
| A link that approves without a click | no GET issues a code: remembered consent does not exist and `prompt=none` only redirects errors |
| A form carried to another request or posted again | the single-use handle bound to the request hash (L-248) |
| Clickjacking the Allow button | `frame-ancestors 'none'`, `X-Frame-Options: DENY`, only top-level navigations reach the page |

## Devices (P5-04)

A **device** is one provider grant: an app approved by one person for one workspace. It carries no secret of its own.

- **Cap:** 25 per person (`MAX_OAUTH_DEVICES_PER_USER`, D-67). `approve()` counts the person's grants other than the one
  this approval replaces and refuses with `device_limit` at the cap, then ranks the new grant against the rest (oldest
  first, ties by id) after inserting it and undoes it when it falls outside the cap, so concurrent approvals cannot
  exceed it. The list and "disconnect all" read the same bound.
- **Silent authorization revokes nothing** (L-247): `completeAuthorization` is called with `revokeExistingGrants: false`. After a
  **successful code exchange** the token endpoint revokes the person's older devices of the same client, workspace and
  redirect URI (tombstone first) and writes `oauth.device.replaced`.
- **Disconnect:** `GET /api/admin/v1/me/oauth-devices`, `POST /me/oauth-devices/{id}/revoke` and `POST
  /me/oauth-devices/revoke-all` (any signed-in role, a session only; no route takes a user id; another person's device is a
  `404`); My access renders them (`/admin/me`). Revoking writes the tombstone, deletes the grant and every token of it,
  clears the access cache and writes `oauth.device.revoke` (`via: my_access`). A refresh token or access token of a
  disconnected device is refused at once (tests).

## Audit

`auth` rows: `oauth.authorize` (ok or denied, with the deny reason; a deny names the person), `oauth.token.issued`,
`oauth.token.refused`, `oauth.token.revoked`, `oauth.code.replayed`, `oauth.device.replaced`, `oauth.device.revoke`;
`admin` rows: `oauth.consent.refused` (the handle and grant refusals above); the device is `oauth_<provider grant id>` in `token_id`, the client in
`client_id`. Tool-call rows of OAuth requests carry the same two ids.

## Plugging in the other tasks

- **P5-03** replaces the open `register()` with caps and expiry and turns CIMD on (`clientIdMetadataDocumentEnabled`,
  `client_id_metadata_document_supported`); `OAuthAuthorizationRequest` gains the client kind.
- **P5-04** (built) supplies the consent handler and lifts the `AB_OAUTH=on` refusal; `oauthConsent` on
  `parseServerSettings`/`assembleServer` is now only a test stand-in.
- **P5-05** builds refresh families and the reuse window over the provider's one-generation rule (D-63).
- **P5-08** adds the administrator views (all users' devices, registered clients) over the same grants; **P5-09** adds per-surface limits (today only the general
  per-IP `beforeAuth` limit applies).

## Testing

One suite (`packages/http-app/test/oauth/suite.ts`), run on memory storage (also in the Workers shape), SQLite
(`apps/cli/test/oauth.test.ts`) and workerd with D1 (`apps/worker/test/oauth.test.ts`, bundling
`test/fixtures/oauth-entry.ts`, the Worker plus the consent stand-in). The clients are the MCP SDK's OAuth functions. The
consent stand-in (`test/oauth/consent.ts`) approves what the `x-test-approve` header says; the built-in screen has its own
suite (`test/oauth/consent.test.ts`: sign-in round trip, every refusal, devices) and a browser spec
(`e2e/oauth-consent.spec.ts`, desktop and 320 px, CSP watch). Discovery is tested with
the SDK's `auth()` and `discoverOAuthProtectedResourceMetadata` (no `validateResourceURL` workaround), once from the
challenge's `resource_metadata` URL and once by path insertion. Provider quirks: it prints a
`console.warn` about CIMD on load without Workers' `global_fetch_strictly_public` flag; the previous refresh token stays valid
once; code expiry rests on the `kv` TTL. Mutation checks are recorded in the P5-01 and P5-02 task Outcomes.
