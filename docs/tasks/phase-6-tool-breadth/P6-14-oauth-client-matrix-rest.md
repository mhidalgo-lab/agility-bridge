---
id: P6-14
title: OAuth client matrix for the remaining clients
phase: 6
status: todo
priority: medium
depends_on: [P5-06]
adr: ["0016"]
lessons: [L-023, L-024, L-263]
owner: ""
---

# P6-14 — OAuth client matrix for the remaining clients

## Goal
Finish the real-client OAuth matrix that P5-06 started, so every primary client is verified or documented as unsupported
before the release gate.

## Scope
- Against the real deployment (Worker `agility-bridge`, Cloudflare Access, `AB_OAUTH=on`): Claude mobile, Claude Desktop
  connectors, VS Code, JetBrains, Copilot CLI and MCP Inspector; Cursor and Windsurf / Devin Desktop when a subscription
  is available (otherwise documented as not verified).
- For each: discovery, registration path (client metadata document or dynamic registration), consent, tool calls,
  refresh, disconnect from My access, reconnect (one device again).
- claude.ai web and Claude Code: disconnect and reconnect, not run in P5-06; claude.ai web: a refresh after the first
  hour (the matrix marks it "not run").
- Answer D-68 (does any client still need dynamic registration?) and D-69 (does a client need a private-use redirect such
  as `cursor://`?) from the runs; P5-15 holds the work if one does.

## Acceptance criteria
- [ ] Every primary client in docs/reference/client-compatibility.md has an OAuth row with version and date, or is
  documented as unsupported or not verified with the reason.
- [ ] D-68 and D-69 are revisited with the evidence.

## Security notes
THREAT_MODEL T10 (registration) and T15 (devices): record only shapes, client ids and grant types, never tenant content.

## Lessons applied
- L-023 — SDK conformance does not prove client compatibility.
- L-024 — Hosted clients have their own rules.
- L-263 — A task lives in its parent's project; "not found" may be the workspace's project boundary.

## Docs to update
- docs/reference/client-compatibility.md

## Out of scope
- Client-side fixes in third-party clients.
