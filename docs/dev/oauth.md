# OAuth 2.1 server (developer guide)

Status: P5-01 (server), P5-02 (resource metadata), P5-03 (clients), P5-04 (sign-in, consent, devices), P5-05 (token lifecycle) and P5-09 (abuse controls) built; **off by default**.
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
| `oauth-rotated:<sha256(spent refresh token)>` | rotation marker `{"at": ms}`: the token was spent (P5-05); kept for the refresh lifetime so a late replay is recognised | none (a hash of a spent token and a time) |
| `oauth-successor:<sha256(spent refresh token)>` | the answer the spent token got (new access and refresh token, expiry, scope, resource, client), **sealed**; kept for the reuse window only | AES-GCM under a key derived from the spent token (D-70) |
| `oauth-refresh-claim:<sha256(refresh token)>` | the request that is spending this token, 15 s | none |
| `oauth-used:<user>:<grant>` | when the device was last used: epoch ms, nothing else (P5-14); written at most every 5 minutes per device and process, deleted when the device is revoked, expires with the longest token it could hold | none (a time) |
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
- Issuance (code and refresh): `resolveAccess` again, then the reason's class (`DENY_CLASS` in `packages/auth`, ADR-0018,
  D-77). **Final** reasons (and `principal_mismatch`, `oauth_mismatch`, `client_revoked`, the grant ending within a minute):
  `invalid_grant`, the device is revoked, `oauth.token.refused` with `revoked: true`. **Recoverable** reasons
  (`workspace_disabled`, `instance_disabled`, `user_disabled`, `credential_revoked`, `credential_unvalidated`,
  `no_projects`, `no_tools`): `503 temporarily_unavailable` with `Retry-After: 60` (the provider's `OAuthError` with a
  status and headers, which does not revoke); the device and the refresh token are untouched (the provider throws before it
  rotates) and `oauth.token.refused` has `revoked: false`. At a code exchange the code is spent either way. A new
  `DenyReason` does not compile until classified (`Record<DenyReason, ...>`), and `packages/auth/test/deny-class.test.ts`
  compares the keys with the union's source. Lifetimes are capped at the grant's expiry, and under a minute left is final.
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
## Refresh tokens (P5-05, D-63, D-70)

`refreshGrant` (`oauth/server.ts`; the seal and the client-id reader are `oauth/refresh-family.ts`) wraps the token
endpoint's `refresh_token` grant for every token of our shape; anything else is the provider's to refuse.

```
refresh(R) ─▶ tombstone of the device?  yes ▶ invalid_grant (and revoke again)
           ─▶ marker oauth-rotated:<h(R)> present?
                no  ▶ claim oauth-refresh-claim:<h(R)> (setIfAbsent) ─▶ won: re-read the marker, then the provider rotates
                      (the provider's issuance check re-runs the access decision), tombstone re-checked, THEN the sealed
                      successor is written, THEN the marker, then the claim is released
                      ─▶ lost: poll for the marker (10-250 ms, about 40 times), then answer as "present"; a released claim
                         with no marker (the winner failed) lets the next request take its turn; none left: 503
                yes ▶ age < window?  no ▶ REUSE: revoke the device (tombstone, grant, tokens), `oauth.refresh.reuse`, invalid_grant
                                     yes ▶ open the sealed successor with R, check the device is still there, authenticate
                                           the client (probe), client id, resource, scope, grant expiry, access decision,
                                           answer with the same tokens (`expires_in` recomputed)
```

- **One rotation per token.** The provider mints a successor per call and keeps only the last (L-164), so the claim, the
  re-read after winning it and the write order (sealed answer, marker, release) are what make parallel refreshes
  converge on one successor (L-253). A claim lives 15 s; a rotation slower than that could double-rotate (the later
  successor would orphan the earlier one and the client would reconnect: bounded, never a leak).
- **The provider's "previous token works once" rule is never reached** for a token we saw spent: its marker answers first.
  A token whose rotation was not recorded (the process died between the provider's write and ours) is still the
  provider's previous token and rotates once more.
- **The replay path does not reach the provider's grant handler**, so it redoes what that handler would: the client is
  authenticated by a probe (the same request with a refresh token that cannot be real: the provider authenticates the
  client first and answers `invalid_grant` when that worked, `invalid_client` otherwise) and its id (Basic header, else
  `client_id`; assertions are refused) must be the one the successor was issued to; `resource` must be the grant's;
  `scope` must grant something; the grant must exist and not be about to expire; the access decision runs again on the
  grant's decrypted props (`unwrapToken` of the successor's access token) and a final refusal revokes the device like at issuance (L-254); a recoverable one answers the same `503` and keeps it (ADR-0018).
- **Reuse** is any repeat with no sealed successor left, i.e. after the window, or at window 0. It revokes the device and
  clears the access cache. Only a token whose hash has a marker can cause it: a forged secret for a real device is the
  provider's `invalid_grant` and costs nothing.
- **The seal** is AES-256-GCM, key = HKDF-SHA-256 of the spent refresh token, info and AAD = its hash; the database holds
  nothing that opens it (D-70, L-255). It is deleted by expiry after the window; markers expire after the refresh lifetime.
- Settings: `AB_OAUTH_REFRESH_REUSE_WINDOW` (`refreshReuseWindowSeconds`, 0-120, not above the access lifetime).

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
- **Not built:** remembered consent (D-66), write consent (Phase 7), CIMD identification (built in P5-03, not yet shown on the page).

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

### Last use and idle expiry (P5-14, D-131)

- `touchDevice` writes `oauth-used:<user>:<grant>` at a token issuance (code exchange, refresh) and after a successful MCP
  authentication. A per-process map of the last write time (bounded, cleared when full) keeps the hot path free of storage
  reads and writes inside the 5-minute interval; the row is a `kv` row, not grant metadata, because the provider rewrites
  the grant on every refresh. Failures are logged and never fail the request.
- `GET /me/oauth-devices` returns `lastUsedAt` (epoch ms, or `null` when the device has no row yet: approved before the
  feature, or the row expired). My access shows it as "Last used". The administrators' list does not (P5-08 is unchanged).
- `AB_OAUTH_IDLE_TTL` (`idleTtlSeconds`, 1 h to 365 d, default off): at a **refresh**, `checkIssuance` refuses a device whose
  row is older than that as `device_idle`, a final reason, so the provider revokes the grant and the refusal is audited as
  `oauth.token.refused` (`revoked: true`). A missing row is not idle. The authorization step and the code exchange never
  check it (L-090: nothing an attacker can navigate to ends a device). An idle time longer than the refresh lifetime has no effect.

## Administrators: connected apps and registered clients (P5-08)

`My access` lists a person's own devices; owners and admins also see everyone's, and owners see the clients.

- **Routes** (tag `oauth`, the admin API; `404` when OAuth is off, after the role check): `GET /oauth/devices` (owner, admin),
  `POST /oauth/devices/{id}/revoke` with `{userId}` (owner: anyone's; admin: a member's or their own; `guardedServices(...).oauth`, the
  rule of `authorizeEndSessions`; a device that is not under that person is `404`), `GET /oauth/clients`,
  `POST /oauth/clients/revoke` and `POST /oauth/clients/restore` with `{clientId}` (owner). The panel posts the same
  through `/admin/oauth/*` with CSRF, `Origin` and fetch metadata. Nothing here is a GET that changes anything (L-090).
- **Storage reads are bounded** (L-097): the device list reads `limit` (10 by default, 50 at most) grant keys from `oauth:grant:` after
  a cursor and one record each, resolving each app's name once; the client list reads `limit` (10, 25 at most) records
  after a cursor, then at most 100 grants to count devices (a failure there gives `devices: null`, not an error), then up to 20
  block rows. Revoking a client reads at most 1,000 grants.
- **Revoking a client** writes `oauth-client-blocked:<sha256 of the client id>` first, deletes `oauth:client:<id>`, then
  revokes every grant of the client (tombstone first, like any revoke). The block is checked in `resolveClient`
  (authorize, consent re-validation and token endpoint, one read), in the issuance check (a refresh revokes the device) and
  in `authenticate` (an access token stops even when a grant is still waiting to be ended). A dynamic client's block row
  expires when every token it could hold has; a metadata-document client's stays until `restore` (D-74).
- **Disconnect and the access cache.** `authenticate` validates the token against the provider's store on a cache miss and
  caches the decision for `AB_ACCESS_CACHE_TTL` (30 s default, 60 s at most; keyed by token hash and slug). The revoking process
  clears its cache; other processes serve a cached token until its entry ends, so a disconnect takes effect within the TTL.
  Refresh has no cache: the tombstone and the grant are read on every refresh. `defineOAuthCacheSuite` proves both (a second
  process is played by changing the shared store without clearing the cache).
- **Audit**: `oauth.device.revoke` (`auth` row for the device's person; `details.via` is `admin` or `client_revoke`, `by` the
  administrator's user id), `oauth.client.revoked` (kind, host, devices, complete), `oauth.client.restored`; and `admin` rows
  `oauth_device.revoke`, `oauth_client.revoke`, `oauth_client.restore` (target, `userId` or `clientId`, role of the actor). No token,
  code or secret in any of them.
- Tests: `test/oauth/admin-suite.ts` on memory (both shapes), SQLite and workerd/D1 (the break-glass token as the owner);
  `admin-oauth.test.ts` (roles, CSRF, panel, hostile names); `e2e/oauth-consent.spec.ts` (1280 and 320 px).

## Client registration (P5-03)

Two ways for a client to get a `client_id`; both end as an `oauth:client:<id>` record the provider reads, so redirect
matching and grants work the same for either.

**Client ID Metadata Documents (CIMD).** A `client_id` that is an https URL names a JSON document. We resolve it ourselves
(`clientIdMetadataDocumentEnabled` stays `false` in the provider: its fetcher follows redirects and needs the Workers flag).
`resolveClient` runs at `/oauth/authorize` and `/oauth/token`, before the provider looks the client up and before a code is
consumed:

1. The id is checked **before any fetch**: at most 400 characters, canonical (`URL.href` equals the string: no dot
   segments, uppercase host, `:443`, backslash), https, a path, no userinfo, fragment or port (stricter than the draft,
   which allows a port), a DNS name with a dot (no IP literal in any spelling, no `.local`, `.internal`, `.test`, ...),
   not our own host.
2. A stored record (`client:<url>`) means no fetch. Otherwise the stored-document cap (`AB_OAUTH_CIMD_MAX_CLIENTS`, 200) and
   the per-address budget (`AB_OAUTH_CIMD_FETCH_LIMIT`, 20 an hour, an atomic `kv.increment` with `max`, keyed by a hash of
   the address) are checked, then the fetch counts, success or not. **At the cap one stored document, chosen at random, is
   evicted** (audited once per window as `oauth.client.evicted`) instead of the request being refused: a stored document is
   only a cache, so the cap bounds storage without letting one source that fills it (each document may be cached for a day)
   keep every other client out (P5-10, D-76).
3. The fetch is `GET`, `Accept: application/json`, no redirects (a 3xx is a failure), 5 s for headers and body together
   (raced, so a fetcher that ignores its signal cannot hold the request), 200 and a JSON media type, 5 KiB declared and
   streamed, UTF-8. **The guard is the host's fetcher**: Node refuses any non-public address at connect time
   (`createClientMetadataFetch`, the P2-19 guard: every answer of the lookup is checked, so a rebinding answer or a mixed
   answer is refused; address literals before DNS); Workers use `global_fetch_strictly_public` (`wrangler.jsonc`, read
   from the runtime) and `redirect: 'manual'`. A host without a guard turns CIMD off (metadata says so).
4. The document must name exactly its URL in `client_id`, have a safe `client_name`, no `client_secret*`, no auth method
   but `none`, the code grant, and redirect URIs; only `https` on the client id's host and `http` on loopback are kept
   (RFC 8252; the provider matches any port on a loopback redirect), the rest are dropped; none left is a refusal.
5. The record is stored with the `Cache-Control` lifetime clamped to 5 min - 24 h (1 h default). Errors are never cached.

A refusal is a `400 invalid_client` JSON answer with one generic sentence, never a redirect and never a 500; the reason
and the id's host go to the log and to an `oauth.client.refused` audit row. **At the token endpoint only verdicts on the
client are `invalid_client`** (the document names another client, is not valid, is gone with a `4xx`): a passing condition
(the client's server answered `5xx` or `429`, the fetch failed or timed out) is `503 temporarily_unavailable` with
`Retry-After`, and a spent fetch budget is `429`, because an SDK client answers `invalid_client` by discarding its
registration and tokens and asking the person to approve again (P5-10). The authorization endpoint keeps its `400` page.

**Dynamic Client Registration (RFC 7591)**, on by default (`AB_OAUTH_DCR`, D-68). The request is parsed and **rebuilt**:
only `redirect_uris`, `client_name`, `token_endpoint_auth_method` (`none`, `client_secret_basic`, `client_secret_post`),
`grant_types` and `response_types` reach the provider; `logo_uri`, `client_uri`, `jwks_uri`, `software_statement`,
contacts and the rest are dropped, so nothing a client names is stored, fetched or shown. Unsupported grants or auth
methods are refused, not silently dropped. Redirect URIs: 1-10, 2,000 characters, no fragment, wildcard, userinfo or
whitespace; `https` on a DNS name or `http` on loopback; `javascript:`, `data:` and the like are refused; private-use
schemes are dropped (D-69), and a request left with none is refused; `AB_OAUTH_DCR_REDIRECT_HOSTS` limits https hosts.
Caps, in this order: per address and hour (`AB_OAUTH_DCR_IP_LIMIT`, 10; atomic counter, so a flood stops at its own
limit and cannot use up the deployment cap for others), then live registrations per deployment
(`AB_OAUTH_DCR_MAX_CLIENTS`, 200, counted from the `kv` table; a concurrent burst may overshoot by its concurrency). At the
cap a bounded sweep (10 records) first removes registrations that never exchanged a code and are over an hour old (D-77), so
a source that fills the cap with registrations it never uses holds it for an hour, not for the unused lifetime. Over either
cap: `429` and `Retry-After`; the first refusal per window and reason is audited, not each one (T20). An unused
registration lives 24 h (`AB_OAUTH_DCR_UNUSED_TTL`); the first token exchange renews it to the registration lifetime
(the provider's half-life rule), so a flood nobody completes is gone in a day. **Only an exchange renews it**: the provider
also renews the registration of any client that gets a `200` at the token endpoint, and an RFC 7009 revocation request
answers `200` to anything, so a public client could keep an unused registration for 90 days with one garbage revocation
request; `token()` puts the stored record back as it was when a revocation renewed a still-unused registration (P5-10).

**Cleanup hooks** (`HttpApp.oauthRegistrations`): `count()` (live dynamic registrations and stored documents) and
`sweep()` (deletes unused registrations older than the unused lifetime now configured: lowering
`AB_OAUTH_DCR_UNUSED_TTL` applies to existing ones). Expired rows are purged by the hosts' housekeeping (see
[Abuse controls](#abuse-controls-p5-09)). P5-08 builds the admin list on these.

**Client names are untrusted text.** They are checked on the way in (length, no control, bidi, zero-width or separator
characters, no Latin/Cyrillic/Greek mixed words) and still go through the escaping of every output path (P5-04 shows them
on the consent screen, marked unverified for dynamic clients, with the vouching host for documents).

## Abuse controls (P5-09)

The unauthenticated endpoints are bounded by **one limiter design**: fixed-window counters in the shared `kv` table, taken
with the store's atomic `increment` (`max`), so the count is exact and deployment-wide on every host (SQLite on Node, D1 on
Workers) instead of per isolate (L-081). The general per-IP limiter (`beforeAuth`, P2-07) stays in front; these counters
add what it cannot: a shared count, and limits that differ per surface (L-079). Code: `oauth/abuse.ts` (the guard),
`runtime.guard()` (the route edge, wired in `app.ts`), the P5-03 caps (`server.ts`) and `oauth/housekeeping.ts`.

| Surface | Counted | Per address | Deployment | Window |
|---|---|---|---|---|
| `GET /oauth/authorize` | every request, before any work | 30 (`AB_OAUTH_AUTHORIZE_IP_LIMIT`) | 600 (`AB_OAUTH_AUTHORIZE_LIMIT`) | 10 min |
| `POST /oauth/consent` | every post, before the session or handle is read | 30 (`AB_OAUTH_CONSENT_IP_LIMIT`) | 300 (`AB_OAUTH_CONSENT_LIMIT`) | 10 min |
| `POST /oauth/token` | **failed** exchanges (a `4xx` except `429`); a refused address is turned away before the code is read | 20 (`AB_OAUTH_TOKEN_FAILURE_IP_LIMIT`) | 300 (`AB_OAUTH_TOKEN_FAILURE_LIMIT`), only against addresses that already failed in the window | 10 min |
| `POST /oauth/register` | per address (P5-03, 10) then **deployment registrations** (new) then live clients (P5-03, 200) | 10 (`AB_OAUTH_DCR_IP_LIMIT`) | 100 (`AB_OAUTH_DCR_LIMIT`) | 1 h |
| CIMD fetches (cache misses) | per address (P5-03, 20) then **deployment fetches** (new) and the stored-document cap (200) | 20 (`AB_OAUTH_CIMD_FETCH_LIMIT`) | 200 (`AB_OAUTH_CIMD_LIMIT`) | 1 h |

- **Address key**: the caller's address as the general limiter keys it (`addressKey`: an IPv6 address by its /64 network,
  an IPv4-mapped one as IPv4), then hashed. Keyed per exact IPv6 address, one host with a /64 could rotate addresses past
  every per-address limit and then exhaust the deployment caps alone (P5-10). The hash keeps the address out of storage as
  written, but an IPv4 hash can be guessed back by brute force: the rows live for one window (D-78).
- **Order**: the address first, then the deployment (L-251). A flood from one address stops at its own limit and has taken
  nothing from the deployment counter, so it cannot lock others out; only many addresses together can reach a deployment
  cap (documented, T20; the knobs are the settings above, `AB_OAUTH_DCR=off` and an edge rule, P5-19).
- **Token failures** are the one place the deployment limit does not apply to everybody: it only refuses addresses that
  already have a failure in the window, so a client with a clean record is never locked out by someone else's failures
  (D-73). Successful exchanges write no counter.
- **Refusal**: `429`, `Retry-After` (seconds to the end of the window), the JSON `temporarily_unavailable` body the OAuth
  routes already use, before any endpoint code: nothing is stored, fetched, read from Agility or consumed (a code
  presented by a refused address stays valid for its holder). The first refusal per window, surface and scope writes one
  `oauth.request.refused` row (`reason`, `surface`, `scope` `address` or `deployment`, `limit`) and one log line; counters
  are keyed by a hash of the address and nothing logged or audited holds an address (T25).
- **Cost on Workers** (D-27, L-097): a taken unit is one D1 row write; a refused `increment` writes nothing; the isolate
  remembers which counters refused until their window ends (a hashed counter name and a time, no request data), and the
  audit markers it has seen, so a flood costs about `limit + 1` writes per counter and window and no further query. Each
  authorization request costs two writes, a failed token request two, a consent post two. When the counter store itself
  fails the request goes on (fail open, logged, L-080): the request limiter and the storage the request needs anyway are
  still in front of it.
- **Windows are fixed**, so a client can use a limit twice around a boundary (at most twice the limit in any ten minutes).
  The counters expire with their window plus the audit markers' extra window; `purgeExpired` reclaims them (D-72).
- **Rows after a flood**: at most one counter per address and surface per window, plus one deployment counter per
  surface; stored clients and documents are bounded by their caps; nothing is stored for a refused request. The number of
  distinct addresses is bounded by the general limiter and the address space, and the rows are gone after their window.

**Housekeeping.** Expired rows (counters, markers, sessions, provider records) are only ever removed by a job. The Worker's
cron already ran `kv.purgeExpired` (1,000 per run); it now also sweeps unused dynamic registrations, 20 per run, resuming
from a cursor row (`oauth-sweep-cursor`), because a run has 50 D1 queries on the Free plan. `agility-bridge serve` had no
purge job: it now runs one at start and hourly (up to 20,000 rows per run) together with the full registration sweep
(`scheduleStorageHousekeeping`). Both call `sweepRegistrations(storage, …)`, which needs only the storage, so the OAuth
runtime is not involved. Stored document clients expire by their own TTL (5 min to 24 h) and are reclaimed by the purge.

## Audit

`auth` rows: `oauth.authorize` (ok or denied, with the deny reason; a deny names the person), `oauth.token.issued`,
`oauth.token.refused`, `oauth.token.revoked`, `oauth.code.replayed`, `oauth.refresh.reuse` (a spent refresh token reused after
the window: the device was revoked; `details` carry the window, never a token), `oauth.device.replaced`, `oauth.device.revoke`, `oauth.client.revoked`, `oauth.client.restored`, and for clients `oauth.client.registered`, `oauth.client.fetched`, `oauth.client.refused` (kind, host, limit, stable reason; never a document), `oauth.client.evicted` (a stored document dropped at the cap, once per window);
`oauth.token.issued` rows of a refresh say `reused: true` when the reuse window answered them;
`admin` rows: `oauth.consent.refused` (the handle and grant refusals above); `auth` rows `oauth.request.refused` (P5-09: a limit was reached; reason, surface, scope and limit, once per window, never an address); the device is `oauth_<provider grant id>` in `token_id`, the client in
`client_id`. Tool-call rows of OAuth requests carry the same two ids.

## Plugging in the other tasks

- **P5-03** (done, see [Client registration](#client-registration-p5-03)): caps and expiry for dynamic registration,
  Client ID Metadata Documents, `OAuthAuthorizationRequest.clientKind` and `clientHost` for the consent screen.
- **P5-04** (built) supplies the consent handler and lifts the `AB_OAUTH=on` refusal; `oauthConsent` on
  `parseServerSettings`/`assembleServer` is now only a test stand-in.
- **P5-05** (built) wraps the refresh grant in a refresh family with the reuse window over the provider's one-generation rule (D-63, D-70).
- **P5-08** adds the administrator views (all users' devices, registered clients) over the same grants.
- **P5-09** (done, see [Abuse controls](#abuse-controls-p5-09)): per-surface limits, the sweep schedule and the flood tests.

## Testing

Abuse controls (P5-09) have a third shared suite (`abuse-suite.ts`) on the same three hosts, with the default limits: a
flood of one address per endpoint (authorize, token failures, registration, document fetches) must stay within the
stored-row and outbound-fetch budget, answer `429` with `Retry-After`, be audited once, and leave another address and the
legitimate client untouched. `abuse.test.ts` adds what needs a moving clock and small limits (windows, both caps, the
audit once per window, fail-open, no storage write for a remembered refusal, the sweeps, the settings),
`abuse-consent.test.ts` the consent post on the built-in screen, and `apps/worker/test/scheduled-oauth.test.ts` the cron's
bounded sweep. A host picks the caller's address with a header (`OAuthHost.address`).

Client registration (P5-03) has a second shared suite (`clients-suite.ts`) on the same three hosts, with a fake origin of
metadata documents (`documents.ts`: injected fetcher on Node, Miniflare `outboundService` in workerd, so nothing touches
the network), plus unit tests of the policy and the bounded fetch (`clients.test.ts`), settings and caps with time
travel (`clients-memory.test.ts`), the Node fetcher over real local HTTP and the public-only guard with a replaced
resolver (`apps/cli/test/client-metadata-*.test.ts`).

One suite (`packages/http-app/test/oauth/suite.ts`), run on memory storage (also in the Workers shape), SQLite
(`apps/cli/test/oauth.test.ts`) and workerd with D1 (`apps/worker/test/oauth.test.ts`, bundling
`test/fixtures/oauth-entry.ts`, the Worker plus the consent stand-in). The clients are the MCP SDK's OAuth functions. The
consent stand-in (`test/oauth/consent.ts`) approves what the `x-test-approve` header says; the built-in screen has its own
suite (`test/oauth/consent.test.ts`: sign-in round trip, every refusal, devices) and a browser spec
(`e2e/oauth-consent.spec.ts`, desktop and 320 px, CSP watch). Discovery is tested with
the SDK's `auth()` and `discoverOAuthProtectedResourceMetadata` (no `validateResourceURL` workaround), once from the
challenge's `resource_metadata` URL and once by path insertion. Provider quirks: it prints a
`console.warn` about CIMD on load without Workers' `global_fetch_strictly_public` flag; its previous refresh token stays valid
once, without a time limit (our family answers first, P5-05); code expiry rests on the `kv` TTL. The refresh family has its own suite (`defineRefreshFamilySuite`, run on all four hosts with the default window and with window 0, so the reuse paths also run where time cannot move: SQLite and workerd) and unit tests of the seal. Mutation checks are recorded in the P5-01, P5-02, P5-04 and P5-05 task Outcomes.
