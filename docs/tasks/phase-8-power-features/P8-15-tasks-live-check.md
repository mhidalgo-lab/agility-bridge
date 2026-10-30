---
id: P8-15
title: Verify MCP Tasks with MCP Inspector and a real client
phase: 8
status: todo
priority: low
depends_on: [P8-10]
adr: ["0005"]
lessons: [L-016]
owner: ""
---

# P8-15 — Verify MCP Tasks with MCP Inspector and a real client

## Goal
Replace the *unverified* label on the Tasks extension (P8-10) with a run against a client that implements SEP-2663.

## Scope
- Against a local `serve` with a synthetic Agility (fakes only, never the live tenant): MCP Inspector and one real 2026-07-28 client create a task for a report tool, poll it to `completed`, cancel one, and see the inline path when the extension is not declared.
- Record what the client actually sends (where it declares the extension, the `Mcp-Method` and `Mcp-Name` headers for `tasks/*`, whether it polls with `pollIntervalMs`) and fix any difference from the schema reading in `http-app/src/tasks.ts`.
- If a client misbehaves, decide D-256 again (default off) and say so in the guide.

## Acceptance criteria
- [ ] Notes in `docs/RESEARCH.md` with date and client versions; the guide's *unverified* banner removed or reworded.

## Security notes
THREAT_MODEL T32.

## Lessons applied
- L-016 — Advertise only what works on that transport.

## Docs to update
- docs/guide/tasks.md, docs/RESEARCH.md

## Out of scope
- New task-capable tools.
