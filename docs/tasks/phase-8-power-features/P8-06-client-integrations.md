---
id: P8-06
title: Client integrations (Claude Code plugin, VS Code and Copilot snippets)
phase: 8
status: todo
priority: low
depends_on: [P6-13]
adr: ["0016"]
lessons: [L-023, L-027]
owner: ""
---

# P8-06 — Client integrations (Claude Code plugin, VS Code and Copilot snippets)

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
One-step installs in the clients that support packaged integrations.

## Scope
- Claude Code plugin (MCP entry, commands, skills for common workflows); VS Code install links / `mcp.json` generators; MCP Registry listing; version sync checks.

## Acceptance criteria
- [ ] Installs verified in each client; registry entry validated.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-023 — SDK conformance does not prove client compatibility.
- L-027 — Clients cache tool lists.

## Docs to update
- docs/guide/clients.md
- docs/guide/registry-listing.md (new)

## Out of scope
- Anything not listed under Scope.
