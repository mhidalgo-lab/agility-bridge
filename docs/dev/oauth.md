# OAuth 2.1 server (developer guide)

Status: P5-01 and P5-02 built; **off by default** and `AB_OAUTH=on` is refused until the consent screen (P5-04) exists
([D-60](../pending-decisions/phase-5.md)). Decisions: [ADR-0009](../adr/0009-authentication.md); evidence:
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
        └─▶ consent handler (P5-04): sign in, choose a grant, approve
            └─▶ api.approve({ userId, grantId })  ── resolveAccess(oauth principal) ──▶ code + marker, redirect with iss
client ──POST /oauth/token (form)──▶ verifier format ▶ atomic kv.take(code marker) ▶ provider ▶ issuance check ▶ tokens
client ──POST /w/{slug}/mcp  Authorization: Bearer <access token>──▶ provider.validateToken(resource) ▶ props cross-check
        ▶ resolveAccess(oauth principal) ▶ the same MCP path as a device token
```

Files: `oauth/server.ts` (runtime), `oauth/kv-namespace.ts` (provider KV over `storage.kv`), `oauth/settings.ts`
(`AB_OAUTH*`), `oauth/cloudflare-workers-shim.ts` (Node stand-in for `cloudflare:workers`), routes and the MCP-route hook in
`app.ts`, `AuditWriter.oauth` in `audit.ts`. The provider is imported lazily; the CLI bundle aliases `cloudflare:workers`
to the shim (the provider uses `WorkerEntrypoint` for `instanceof` only), Workers use the real module.

## What is stored where

| Key (`kv`) | Holds | Secret at rest |
|---|---|---|
| `oauth:client:<id>` | registered client (redirect URIs, name, auth method) | secret hashed by the provider |
| `oauth:grant:<user>:<grant>` | device authorization: hashes of the code and refresh tokens, wrapped keys, **encrypted props**, metadata `{grant: <access grant id>}` | hashes and ciphertext only |
| `oauth:token:<user>:<grant>:<sha256>` | access-token record | hash only |
| `oauth-code:<sha256(code)>` | single-use marker, 10 min | hash only |
| `oauth-revoked:<user>:<grant>` | tombstone of a revoked device (refresh lifetime) | none |

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

## Audit

`auth` rows: `oauth.authorize` (ok or denied, with the deny reason), `oauth.token.issued`, `oauth.token.refused`,
`oauth.token.revoked`, `oauth.code.replayed`; the device is `oauth_<provider grant id>` in `token_id`, the client in
`client_id`. Tool-call rows of OAuth requests carry the same two ids.

## Plugging in the other tasks

- **P5-03** replaces the open `register()` with caps and expiry and turns CIMD on (`clientIdMetadataDocumentEnabled`,
  `client_id_metadata_document_supported`); `OAuthAuthorizationRequest` gains the client kind.
- **P5-04** supplies the `consent` handler (`OAuthConsentApi`: `request`, `approve`, `deny`, the provider helpers) and
  lifts the `AB_OAUTH=on` refusal by passing `oauthConsent` to `parseServerSettings`/`assembleServer`.
- **P5-05** builds refresh families and the reuse window over the provider's one-generation rule (D-63).
- **P5-08** lists and revokes devices from `oauth:grant:` rows; **P5-09** adds per-surface limits (today only the general
  per-IP `beforeAuth` limit applies).

## Testing

One suite (`packages/http-app/test/oauth/suite.ts`), run on memory storage (also in the Workers shape), SQLite
(`apps/cli/test/oauth.test.ts`) and workerd with D1 (`apps/worker/test/oauth.test.ts`, bundling
`test/fixtures/oauth-entry.ts`, the Worker plus the consent stand-in). The clients are the MCP SDK's OAuth functions. The
consent stand-in (`test/oauth/consent.ts`) approves what the `x-test-approve` header says. Discovery is tested with
the SDK's `auth()` and `discoverOAuthProtectedResourceMetadata` (no `validateResourceURL` workaround), once from the
challenge's `resource_metadata` URL and once by path insertion. Provider quirks: it prints a
`console.warn` about CIMD on load without Workers' `global_fetch_strictly_public` flag; the previous refresh token stays valid
once; code expiry rests on the `kv` TTL. Mutation checks are recorded in the P5-01 and P5-02 task Outcomes.
