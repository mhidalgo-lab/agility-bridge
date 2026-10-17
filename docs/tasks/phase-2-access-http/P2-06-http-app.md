---
id: P2-06
title: HTTP app (Hono) with per-workspace MCP endpoints
phase: 2
status: todo
priority: high
depends_on: [P2-05]
adr: ["0005", "0008"]
lessons: [L-012, L-014, L-015, L-068, L-082, L-083, L-084, L-151]
owner: ""
---

# P2-06 — HTTP app (Hono) with per-workspace MCP endpoints

## Goal
`agility-bridge serve` exposes each workspace at `/w/{slug}/mcp` with the request flow of ARCHITECTURE §5.

## Scope
- Request id, security headers on every response (HSTS from `AB_PUBLIC_URL`, also on errors), Host/Origin allowlists, `Origin: null` refused, CORS only when configured.
- Body caps (declared and streamed, 1 MiB), JSON-RPC batch refusal, 180 s exchange deadline covering streamed bodies, Node header/request timeouts.
- Authentication → access resolution (cached ≤ 60 s, cleared on admin changes) → rate-limit hooks → per-request MCP server via `createMcpHandler(factory, { legacy: 'stateless' })`.
- Uniform 401 for every denial; 503 on storage errors; minimal `/health` and `/version`.
- MCP method classification for audit and limits (L-015).

## Acceptance criteria
- [ ] Integration tests for both protocol eras, batch refusal, oversized bodies, hostile Host/Origin, wrong workspace.
- [ ] `subscriptions/listen` is not counted as a tool call.
- [ ] Headers present on 401/404/503 responses too.

## Security notes
THREAT_MODEL T2, T15, T19, T20, T24.

## Lessons applied
- L-012 — Treat HTTP as stateless.
- L-014 — Reject JSON-RPC batches explicitly.
- L-015 — Classify every MCP method, not only `tools/call`.
- L-068 — Bound the access cache.
- L-082 — Defend local servers against DNS rebinding.
- L-083 — Derive security headers from the public URL.
- L-084 — Bound everything at the edge.
- L-151 — Health endpoints reveal nothing.

## Docs to update
- docs/ARCHITECTURE.md §5
- docs/guide/self-hosting.md (P2-16)

## Out of scope
- Anything not listed under Scope.
