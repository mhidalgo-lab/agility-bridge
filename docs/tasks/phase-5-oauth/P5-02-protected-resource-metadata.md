---
id: P5-02
title: Protected resource metadata per workspace
phase: 5
status: in-progress
priority: high
depends_on: [P5-01]
adr: ["0009"]
lessons: [L-067, L-087, L-094, L-121]
owner: "claude-agent"
---

# P5-02 — Protected resource metadata per workspace

> Refined 2026-10-24 (tasks/README rule 7), after P5-01, the MCP authorization spec (2025-11-25 and 2026-07-28), RFC 9728
> and relic-bridge's P5-02.

## Goal
Clients that start without a token discover the authorization server from one workspace's MCP URL alone, and learn the
resource (RFC 8707) they must ask a token for. Without this the SDK's `auth()` does not send `resource`, which P5-01's
authorization endpoint requires.

## Scope
- **Metadata**: `GET /.well-known/oauth-protected-resource/w/{slug}/mcp` (RFC 9728 §3.1 path insertion, the first URI
  the spec tells clients to try): `resource` = `{issuer}/w/{slug}/mcp`, `authorization_servers` = `[issuer]`,
  `scopes_supported` = `["mcp:read"]` (no `offline_access`: the spec says it stays out of the challenge and metadata),
  `bearer_methods_supported` = `["header"]`. Built from the path alone: the same answer for a known, unknown and disabled
  workspace, because the MCP route already answers all three with one `401` and anything else would let a caller list
  workspaces (T19; D-64). Only a slug that is not valid syntax is a `404`. No root document (no resource lives at the
  root: the SDK's fallback gets the same `404` as an app without OAuth). Public, limited per IP like the other OAuth
  routes, cacheable (`Cache-Control: public, max-age=300`: it is a function of configuration, not of state).
- **Challenge**: with OAuth on, every `401` on `/w/{slug}/mcp` carries `WWW-Authenticate: Bearer realm="agility-bridge",
  resource_metadata="{issuer}/.well-known/oauth-protected-resource/w/{slug}/mcp", scope="mcp:read"`, for device tokens,
  OAuth tokens and no token alike. It is a function of the path only (no `error=` code, which would tell a missing
  token from an invalid one, and no per-slug difference but the URL). OAuth off, or a slug that is not valid syntax,
  keeps the plain `Bearer`. The metadata and the challenge use the configured public URL, never `Host`.
- **Audience** (RFC 8707) was built in P5-01 (token bound to one workspace, `resource` checked at authorize and token);
  here it is re-tested end to end through discovery: the resource the SDK derives from the metadata is the one the
  authorization endpoint accepts, and a token for A fails at B.
- P5-01's `auth()` test drops its `validateResourceURL` workaround.

## Acceptance criteria
- [ ] The metadata answers with the exact shape above for existing, unknown and disabled workspaces alike (byte-identical
  apart from the path-derived URL), `404` for an invalid slug, a root request, and with OAuth off; cacheable; limited per IP.
- [ ] Every `401` of `/w/{slug}/mcp` with OAuth on carries the challenge (device token, OAuth token, none, malformed,
  wrong workspace, revoked); identical for known and unknown workspaces; OAuth off unchanged.
- [ ] The SDK's `auth()` flow, with no workaround, learns the resource from the metadata via the `401` challenge and via
  path insertion, requests the workspace's resource, and completes; on Node (memory, SQLite) and workerd (D1).
- [ ] A token for workspace A fails at B, and refresh cannot retarget (re-run through the discovered resource).
- [ ] Security tests are mutation-checked (L-121), recorded under Outcome.
- [ ] `docs/dev/oauth.md`, THREAT_MODEL T2 and T19, RESEARCH, ARCHITECTURE (if it describes the 401), a changeset and
  new lessons are done.

## Security notes
THREAT_MODEL T2, T19.

## Lessons applied
- L-067 — Bind each token to one workspace.
- L-087 — One protected resource per workspace.
- L-094 — Follow the OAuth details clients rely on.
- L-121 — Negative authorization is first-class.

## Docs to update
- docs/dev/oauth.md, docs/THREAT_MODEL.md, docs/RESEARCH.md, docs/ARCHITECTURE.md

## Out of scope
- CORS on `/.well-known/*` for browser-based clients (a P5-06 finding if a client needs it).
- `403 insufficient_scope` step-up (no scope but `mcp:read` until write tools).
- Anything not listed under Scope.
