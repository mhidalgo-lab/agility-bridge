---
id: P5-06
title: Real-client compatibility matrix (OAuth)
phase: 5
status: todo
priority: high
depends_on: [P5-02, P5-03, P5-04, P5-05]
adr: ["0016"]
lessons: [L-023, L-024]
owner: ""
---

# P5-06 — Real-client compatibility matrix (OAuth)

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Know, from real runs, which clients connect with OAuth and how.

## Scope
- claude.ai web, Claude mobile, Claude Desktop connectors, Claude Code, VS Code, JetBrains, Copilot CLI, Cursor, Windsurf/Devin Desktop, MCP Inspector: discovery, registration path, consent, refresh, disconnect, reconnect.

## Acceptance criteria
- [ ] Matrix cells marked verified with versions and dates, or documented as unsupported.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-023 — SDK conformance does not prove client compatibility.
- L-024 — Hosted clients have their own rules.

## Docs to update
- docs/reference/client-compatibility.md

## Out of scope
- Anything not listed under Scope.
