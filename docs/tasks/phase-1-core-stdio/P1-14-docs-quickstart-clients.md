---
id: P1-14
title: "Docs: quickstart and client setup guides"
phase: 1
status: blocked
priority: high
depends_on: [P1-11]
adr: ["0016"]
lessons: [L-023, L-026, L-027, L-133]
owner: "Matias Hidalgo"
---

# P1-14 — Docs: quickstart and client setup guides

## Goal
A first-time user goes from an Agility token to a working agent in their client of choice in minutes.

## Scope
- `docs/guide/quickstart-local.md`: create an Agility access token (Applications page), then configure the client.
- `docs/guide/clients.md`: every primary client, local and (later) remote, with secrets kept out of plain text where the client allows it.
- `docs/guide/troubleshooting.md` (initial) and a privacy note: tool output goes to the client's model.
- Executable-docs check for commands that can run in CI.

## Acceptance criteria
- [ ] Each snippet verified in the real client, with version and date recorded in client-compatibility.md. *(MCP
  Inspector CLI 2.11.0 verified 2026-10-21; VS Code, Claude Code, Copilot CLI and JetBrains: owner run pending)*
- [x] The docs check runs in CI. *(`scripts/test/docs.test.ts` in `pnpm test`)*

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-023 — SDK conformance does not prove client compatibility.
- L-026 — Configure stdio servers through the client, never through flags.
- L-027 — Clients cache tool lists.
- L-133 — Execute the documentation.

## Blocker

The snippets for VS Code, Claude Code, Copilot CLI and JetBrains need the owner's run in those clients (their versions
and dates go into client-compatibility.md). Everything else is done: guides, executable docs check, Inspector run, and
`scripts/fixture-agility.ts` to run the checks against synthetic data.

## Docs to update
- docs/guide/*
- docs/reference/client-compatibility.md
- README.md

## Out of scope
- Anything not listed under Scope.
