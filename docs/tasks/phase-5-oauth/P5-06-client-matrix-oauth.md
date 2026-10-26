---
id: P5-06
title: Real-client compatibility matrix (OAuth)
phase: 5
status: review
priority: high
depends_on: [P5-02, P5-03, P5-04, P5-05]
adr: ["0016"]
lessons: [L-023, L-024, L-263]
owner: ""
---

# P5-06 — Real-client compatibility matrix (OAuth)

## Goal
Know, from real runs, which clients connect with OAuth and how.

## Scope
Refined 2026-10-26 with the owner: Phase 5 records the clients run against the real deployment now; the remaining
clients move to [P6-14](../phase-6-tool-breadth/P6-14-oauth-client-matrix-rest.md) and are run during the following phases.
- Deployment: Worker `agility-bridge` on the custom domain, Workers Free, Cloudflare Access sign-in, `AB_OAUTH=on`.
- Run now: claude.ai web and Claude Code (OAuth), Claude Code (device token): discovery, registration path, consent,
  tool calls, refresh.
- Recorded as not run: Cursor and Windsurf / Devin Desktop (no subscription available to the owner), and the rest of the
  list (Claude mobile, Claude Desktop connectors, VS Code, JetBrains, Copilot CLI, MCP Inspector), all in P6-14.

## Acceptance criteria
- [x] The clients run in Phase 5 have matrix cells marked verified with versions and dates
  (docs/reference/client-compatibility.md, "OAuth runs").
- [x] Every other client is listed as not run yet, with the reason, and tracked in P6-14.

## Outcome
- **claude.ai web** (2026-10-26): discovery from the MCP route's challenge; registration by client metadata document
  (`https://claude.ai/oauth/mcp-oauth-client-metadata`); Access sign-in and consent; `whoami`, `query_assets`,
  `get_assets`, `get_work_item` answered. A first "not found" was the workspace's project scope: the task belonged to a
  release project outside the allowed tree (L-263).
- **Claude Code 2.1.310** (2026-10-26): OAuth by client metadata document
  (`https://claude.ai/oauth/claude-code-client-metadata`), consent, tool calls, and a silent `refresh_token` exchange
  after the access token expired (audit row `oauth.token.issued`, grant type `refresh_token`). Also verified with a
  static device token.
- Not tried in Phase 5: disconnect and reconnect from My access, dynamic registration by a real client (D-68), and a
  private-use redirect (D-69): all in P6-14.
- Evidence came from the owner's runs and the audit log only (action, status, client id, grant type); no tenant content
  was recorded.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-023 — SDK conformance does not prove client compatibility.
- L-024 — Hosted clients have their own rules.
- L-263 — A task lives in its parent's project; "not found" may be the workspace's project boundary.

## Docs to update
- docs/reference/client-compatibility.md

## Out of scope
- The clients and steps listed in P6-14.
