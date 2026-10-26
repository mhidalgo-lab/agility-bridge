# ADR-0009 — Authentication: device tokens first, OAuth 2.1 next; admin sign-in providers

- **Status:** accepted (owner, 2026-10-21, on the P0-08 evidence below); the secrets-at-rest sentence of §3 is amended by
  [ADR-0017](0017-oauth-secrets-at-rest.md) for grant properties and the refresh-reuse successor (2026-10-26)
- **Date:** 2026-10-16
- **Related:** P2-05, P4-01, P4-02, P5-01 – P5-09, L-024, L-029, L-066, L-067, L-086 – L-094

## Context

IDE and CLI clients (VS Code, JetBrains, Copilot CLI, Claude Code, Cursor, Windsurf) can send a static header. Hosted
clients (claude.ai web, Claude mobile, desktop remote connectors) require OAuth 2.1 with discovery. Admins need to sign
in to a panel without the project managing passwords.

## Decision

1. **Device tokens first** (Phase 2): `ab_live_<43 base62>_<6 base62 CRC-32>` (`ab_test_…` on non-production
   deployments), 256-bit random, SHA-256 at rest, constant-time comparison, bound to one workspace, 90-day default
   expiry, shown once.
2. **Admin sign-in** (Phase 4): Google, GitHub, Cloudflare Access and any OpenID Connect provider; deny by default with
   allowlists; one `(idp, subject)` identity per user; the first owner is bootstrapped with a single-use setup link
   whose code travels in the URL fragment. A break-glass admin token for automation and recovery is **generated** by
   `agility-bridge admin-token` (typed `ab_admin_…`, 256-bit), passed as `AB_ADMIN_TOKEN`/`AB_ADMIN_TOKEN_FILE`, kept
   only as a digest in memory, compared in constant time and rate-limited on failure; values that are not generated
   tokens are refused at boot.
3. **OAuth 2.1 for MCP clients** (Phase 5), the server acting as its own authorization server:
   - RFC 9728 protected resource metadata per workspace URL; `WWW-Authenticate` challenge on 401.
   - RFC 8707 audience binding: a token for workspace A fails at workspace B; refresh cannot retarget.
   - PKCE S256 for every client; form-encoded token endpoint; RFC 9207 `iss`.
   - Client ID Metadata Documents fetched by the server with an SSRF guard enforced at connect time (or CIMD disabled on
     a runtime that cannot do that); Dynamic Client Registration as a capped, expiring compatibility path.
   - Scopes `mcp:read` and `mcp:write` (write consent is separate and never remembered).
   - Access tokens 1 hour; rotating refresh tokens 30 days with a bounded reuse interval (default 30 s) for concurrent
     refreshes; reuse outside the window revokes the device.
   - All provider state in the storage `kv` table (never isolate memory); codes consumed atomically.
   - **Secrets at rest**: authorization codes, access tokens and refresh tokens are 256-bit opaque values stored
     **hash-only**; grant properties and any recoverable transient secret (PKCE verifier, nonce, refresh-reuse successor)
     are envelope-encrypted; token-family metadata holds nothing secret. Tests scan storage, backups, logs and audit
     rows for plaintext bearer values.
   - A device is replaced only after a successful code exchange, never on a GET.
4. The MCP-side credential (device token or OAuth token) is **never forwarded to Agility**; the Agility token comes only
   from the stored credential (or, in a pass-through workspace, from the caller's `X-Agility-Token` header).

## Consequences

- Laptops and IDEs work from Phase 2; phones and claude.ai from Phase 5.
- The project carries an OAuth server: higher security-review cost, mitigated by the spike (P0-08) and a dedicated
  review (P5-10).

## Evidence (P0-08, 2026-10-21, local workerd and Node, then production on Workers Free)

From [spikes/oauth/RESULTS.md](../../spikes/oauth/RESULTS.md), `@cloudflare/workers-oauth-provider` 1.2.3:

- One authorization server plus one protected resource per workspace (`/w/{slug}/mcp`) works on both runtimes; the
  workspace list must come from storage on every request (relic-bridge's in-memory list failed across isolates; here a
  runtime-added workspace worked on 30 of 30 later requests).
- RFC 9728 per-workspace metadata, RFC 8707 audience binding (cross-workspace token rejected, refresh cannot retarget),
  PKCE S256 only, RFC 9207 `iss`, CIMD (Claude Code's real document) and capped DCR are native.
- An unknown workspace answers with the same 401 challenge as a missing token (T19).
- **Gap:** the promised refresh reuse interval does not exist in the library: parallel refreshes leave only the last
  refresh token usable (L-164). P5-05 implements the reuse interval in our storage.
- Production: every automated check passes on Workers (storage across isolates included); endpoints answer in about
  0.2 s (registration 0.75 s). Real clients: Claude Code 2.1.304 and VS Code 1.142.0 sign in through **CIMD**, MCP
  Inspector CLI 2.11.0 through **DCR**; all three get workspace-bound tokens with `resource` and `offline_access`.

## Alternatives considered

- **Delegating MCP OAuth to Agility's own OAuth2 grants:** rejected for 1.0; Agility OAuth2 grants are configured per
  instance by members, have their own expiry semantics, and would not carry our grants, scopes or audit.
- **Third-party identity broker only:** possible behind the generic OIDC provider; not required.
