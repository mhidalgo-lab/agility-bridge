---
id: P0-07
title: "Spike: MCP SDK v2 dual-era handler with real clients"
phase: 0
status: blocked
priority: high
depends_on: [P0-01]
adr: ["0005", "0016"]
lessons: [L-002, L-011, L-012, L-014, L-015, L-016, L-020, L-023, L-025, L-155, L-156]
owner: "Matias Hidalgo"
---

# P0-07 — Spike: MCP SDK v2 dual-era handler with real clients

## Goal
Confirm that one SDK v2 server serves stdio and stateless HTTP for both protocol eras on Node and Workers, and record what each primary client really does.

## Scope
- A minimal server with a few read tools: stdio, Hono on Node, Hono on workerd.
- For each primary client (VS Code Copilot, JetBrains Copilot, Copilot CLI, Claude Code, Claude Desktop, Cursor, Windsurf/Devin Desktop, MCP Inspector): stdio and HTTP with a static bearer header.
- Record per client: negotiated protocol version, `Mcp-Method`/`Mcp-Name` headers, `subscriptions/listen`, batch behaviour, tool-count and size limits, elicitation per transport (stdio, 2025-era HTTP, 2026-07-28 multi round-trip), `structuredContent` rendering, effect of annotations, error rendering, behaviour after the tool list changes.
- Measure per-request server construction with 25 and 40 tools, with and without schema caching.

## Acceptance criteria
- [ ] `spikes/mcp-sdk-v2/RESULTS.md` with the matrix; *(runtime and elicitation matrix done; real clients: MCP Inspector verified, the rest pending the owner)* verified cells copied into docs/reference/client-compatibility.md with client versions and dates.
- [ ] ADR-0005 accepted or superseded.
- [x] A recorded conclusion on which clients can approve writes through elicitation on which transport (input for P7-01 and P7-02).
- [x] Schema-caching measurements recorded.

## Blocker

The spike, the automated matrix (Node, local workerd, stdio × both eras), the elicitation conclusion and the
schema-caching measurements are done ([RESULTS.md](../../../spikes/mcp-sdk-v2/RESULTS.md), 2026-10-20). What remains
needs the owner's client apps: run [`spikes/mcp-sdk-v2/client-checklist.md`](../../../spikes/mcp-sdk-v2/client-checklist.md)
for VS Code, JetBrains, Copilot CLI, Claude Code, Claude Desktop, Cursor and Windsurf / Devin Desktop, record the cells,
then accept (or supersede) ADR-0005. Set the task back to `in-progress` when that starts.

## Security notes
No real Agility tokens; local servers plus a throwaway Worker.

## Lessons applied
- L-002 — A spike is done only when it ran in production-like conditions.
- L-011 — Serve both protocol eras.
- L-012 — Treat HTTP as stateless.
- L-014 — Reject JSON-RPC batches explicitly.
- L-015 — Classify every MCP method, not only `tools/call`.
- L-016 — Advertise only what works on that transport.
- L-020 — Cache converted tool schemas.
- L-023 — SDK conformance does not prove client compatibility.
- L-025 — Not every client can answer an approval prompt.
- L-155 — Keep the tool count small.
- L-156 — Plan write approval for clients that cannot elicit.

## Docs to update
- docs/reference/client-compatibility.md
- docs/RESEARCH.md §2–§3
- docs/adr/0005-mcp-sdk-v2-stateless.md

## Out of scope
- OAuth (P0-08)
