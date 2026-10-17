# ADR-0005 — MCP SDK v2, stateless HTTP, dual protocol era

- **Status:** proposed (pending spike P0-07)
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
  October 2026 VS Code (GitHub Copilot) and Cursor negotiate only up to 2025-11-25 and reject a server that speaks only
  2026-07-28, while Claude Code, Copilot CLI, Windsurf/Devin Desktop and MCP Inspector already use 2026-07-28
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

## Alternatives considered

- **SDK v1 with stateful sessions:** rejected; needs session affinity and does not match the 2026-07-28 model.
- **Only the newest protocol era:** rejected until the client matrix shows the 2025 era is gone.
