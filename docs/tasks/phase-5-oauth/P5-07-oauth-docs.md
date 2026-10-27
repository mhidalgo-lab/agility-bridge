---
id: P5-07
title: OAuth documentation
phase: 5
status: done
priority: medium
depends_on: [P5-06]
adr: []
lessons: [L-133, L-264]
owner: "claude (agent)"
---

# P5-07 — OAuth documentation

## Goal
Users connect claude.ai, phones and IDEs with OAuth by following the guides, and an operator can turn OAuth on and
diagnose a failed connection without reading the code.

## Scope
Refined 2026-10-27 after the owner's real runs (P5-06, 2026-10-26). Pages are under `docs/guide/oauth*.md`, linked from
the README and the guide pages that mention OAuth.
- **Connect claude.ai web and the phone** (update `oauth-phone.md`): Settings, Connectors, custom connector with
  `https://<host>/w/<slug>/mcp`; sign-in, consent, tools; connectors added on the web reach mobile.
- **Connect IDEs and CLIs** (new): Claude Code, VS Code, JetBrains, Copilot CLI, Cursor, Windsurf, each marked verified
  or documented only, taken from the "OAuth runs" table of the client matrix (claude.ai web and Claude Code are the
  verified ones; the rest wait for P6-14).
- **How OAuth works** (update `oauth-how-it-works.md`): discovery, registration (client metadata document, DCR), consent.
- **Operator page** (new): turning OAuth on for `serve` and for Workers (prerequisites: public HTTPS and a sign-in
  provider), the registration settings and decisions D-68 and D-69. On Workers `cf:setup` must be able to set and keep
  `AB_OAUTH` (an `--oauth on|off` option, or documented).
- **Troubleshooting** (new): discovery (the 401 challenge, `/.well-known/*`, Host allowlist, `AB_PUBLIC_URL`), redirects
  (private-use schemes, loopback, the redirect host allowlist), sign-in and consent failures (audit reasons), registration
  caps and 429, "not found" versus the project scope (L-263), disconnect and reconnect, refresh reuse.
- Execute the documentation (L-133): every runnable command runs; unauthenticated read-only checks against the real
  deployment (`/health`, the two `/.well-known/*` documents, the tokenless 401); browser steps are the owner's and are
  marked "owner-verified" with the date or listed as owner steps.

## Acceptance criteria
- [x] The web and phone guide, the IDE and CLI guide, the operator page and the troubleshooting page exist and the how-it-works page is updated; all are linked from the README.
- [x] Each client in the IDE guide says whether OAuth was verified (version, date) or is documented only, matching the client matrix.
- [x] `AB_OAUTH` survives a repeated `cf:setup` run (an `--oauth on|off` option that keeps the value when omitted, with tests), and the guides say how to turn OAuth on for Workers and Node.
- [x] Every runnable command in the guides ran (docs tests, `cf:setup --dry-run`), and the discovery documents and the 401 challenge were checked against the real deployment without authenticating.
- [x] Browser steps are marked "owner-verified 2026-10-26" where the owner's run covered them, otherwise listed as owner steps in the Outcome.
- [x] No real host name, tenant name, id or email appears in the docs.

## Outcome
- **Pages:** [operator guide](../../guide/oauth-operator.md), [claude.ai and phone](../../guide/oauth-phone.md) (rewritten),
  [IDEs and CLIs](../../guide/oauth-ides.md), [how it works](../../guide/oauth-how-it-works.md) (discovery and registration
  added), [troubleshooting](../../guide/oauth-troubleshooting.md); linked from the README, the configuration, clients,
  quickstart, admin panel, deploy and troubleshooting guides.
- **cf:setup:** `--oauth on|off` added (small): it writes `AB_OAUTH` into the local config and a later run without the flag
  keeps the value (`scripts/test/cf-setup.test.ts`). It warns when OAuth is on and no sign-in variable is in the config.
- **Executed (2026-10-27):** the discovery `curl`s (`/health`, both `/.well-known/*` documents, tokenless `POST` to the MCP
  route: `401` with the `resource_metadata` challenge) against the real deployment, unauthenticated; and against a throwaway
  local `serve` (built CLI, fake Google client): the same documents, `403` for a wrong `Host`, `404` for a malformed slug,
  `404` and a bare `Bearer` challenge with OAuth off, the refusal when no provider is configured, DCR `201` for a loopback
  redirect and `invalid_redirect_uri` for a private-use one. Run from source the registration answers `500` because the
  `cloudflare:workers` alias exists only in the built bundle (not a defect of the product). Docs snippet tests pass.
- **Owner-verified 2026-10-26:** claude.ai web connector (sign-in, consent, tools), Claude Code 2.1.310 (`claude mcp add`,
  Authenticate, silent refresh), the Access sign-in and the `reauth_stale` then success retry, the project-scope "not found".
- **Owner steps left:** the phone app (iOS and Android), Claude Desktop, VS Code, JetBrains, Copilot CLI, Cursor, Windsurf
  and MCP Inspector against this release (P6-14); disconnect and reconnect of claude.ai and Claude Code.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-133 — Execute the documentation.

## Docs to update
- docs/guide/oauth*.md

## Out of scope
- Anything not listed under Scope.
