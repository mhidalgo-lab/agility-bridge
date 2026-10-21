# ADR-0005 — MCP SDK v2, stateless HTTP, dual protocol era

- **Status:** accepted (owner, 2026-10-21, on the P0-07 evidence below)
- **Date:** 2026-10-16
- **Related:** P0-07, P1-01, P2-06, L-011 – L-019, L-023

## Context

MCP clients in the field speak two protocol eras: the 2025-era revisions (with an `initialize` handshake) and the
2026-07-28 revision, which removes protocol-level sessions, adds `server/discover`, carries capabilities per request in
`_meta` and adds the `Mcp-Method` / `Mcp-Name` HTTP headers. Workers have no sticky sessions, and a shared server must
not keep per-session state in memory.

## Decision

- Use the **MCP TypeScript SDK v2** (`@modelcontextprotocol/server`), pinned to an exact version.
- **HTTP is stateless:** one `createMcpHandler(factory, { legacy: 'stateless' })` per app; the factory builds a fresh
  server per request with only the caller's granted tools; the resolved access scope travels in `authInfo.extra`.
- **Both eras are served** on every runtime (stdio pins the era per connection). This is mandatory, not a nicety: in
  October 2026 Copilot in JetBrains, MCP Inspector CLI and (documented) Cursor negotiate only 2025-era revisions, while
  Claude Code, Copilot CLI, VS Code (verified in P0-07) and Windsurf/Devin Desktop use 2026-07-28
  ([RESEARCH §3](../RESEARCH.md#3-mcp-clients)). Features that need per-request capabilities (elicitation through multi
  round-trip requests, the Tasks extension) are offered only to requests that declare them.
- `tools.listChanged`, `prompts.listChanged` and `resources.listChanged` are `false` on HTTP; clients reconnect after
  upgrades (documented).
- JSON-RPC batches are rejected before the SDK; every MCP method is classified for audit and rate limits.

## Consequences

- No sticky sessions or Durable Objects needed for MCP itself; horizontal scaling is trivial.
- Server-initiated notifications are not available on HTTP; long work uses explicit handles or the Tasks extension.
- The P0-07 spike must confirm SDK behaviour with real clients (headers, `subscriptions/listen`, elicitation per client,
  `tools/list` size) before this ADR is accepted.

## Evidence (P0-07, 2026-10-20)

From [spikes/mcp-sdk-v2/RESULTS.md](../../spikes/mcp-sdk-v2/RESULTS.md), SDK 2.3.1:

- `createMcpHandler(factory, { legacy: 'stateless' })` serves both eras on Node and local workerd, without
  `nodejs_compat`; `serveStdio(factory)` pins the era per connection. The grant reaches the factory through
  `authInfo.extra`; the SDK never reads headers, so bearer and workspace checks stay in the Hono route.
- **Batches:** the 2025-era path answered a two-request JSON-RPC batch, so the "rejected before the SDK" rule above is
  required, not defensive (P2-06).
- **Elicitation:** works on stdio (both eras) and on 2026-07-28 HTTP through `inputRequired(...)`, never on 2025-era HTTP
  (a stateless request has no client capabilities). Verified with real clients: Copilot CLI 1.0.87, Claude Code
  2.1.304 and VS Code approve and decline over stdio and HTTP; Copilot in JetBrains (2025 era) is refused over HTTP and
  needs the approval page for remote writes (P7-02), as does Cursor if it is still on 2025-11-25.
- **Per-request construction:** register tool schemas converted to JSON Schema once per process (`fromJsonSchema`):
  0.70 ms vs 4.89 ms p50 for a 25-tool `tools/list` (P1-01).
- Real clients: MCP Inspector CLI 2.11.0 verified here; Claude Code 2.1.287 and GitHub Copilot (desktop) were verified
  with the same SDK pattern in relic-bridge's spike (2026-10-02). The rest of the matrix is the owner's checklist.

## Alternatives considered

- **SDK v1 with stateful sessions:** rejected; needs session affinity and does not match the 2026-07-28 model.
- **Only the newest protocol era:** rejected until the client matrix shows the 2025 era is gone.
