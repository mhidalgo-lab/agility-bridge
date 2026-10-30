# Charts in clients that support MCP Apps

Two tools can show a chart instead of only a table, in a client that supports [MCP Apps](https://github.com/modelcontextprotocol/ext-apps)
(an extension that lets a tool result open a small page in the conversation). Every other client gets the same text and
structured result as before; nothing about a tool changes for them.

| Tool | View | What it draws |
|---|---|---|
| `get_sprint` | `ui://agility-bridge/sprint-burndown` | The remaining estimate of the sprint, day by day, against the ideal line (needs the burndown the tool reads from history) |
| `sprint_health` (reports) | `ui://agility-bridge/status-distribution` | The sprint's items by status category as bars |

## When a client is offered a view

A view is offered only when **all** of these hold:

- the client declared the extension (`io.modelcontextprotocol/ui` with `text/html;profile=mcp-app`) when it connected;
- the server has not turned it off (`AB_MCP_APPS=off`, or `mcp_apps: false` in the workspace YAML on stdio);
- the caller holds the tool that links the view (a grant without `get_sprint` never sees the burndown view);
- the connection can tell: a 2026-07-28 request carries its capabilities, and a stdio connection keeps the ones declared at
  `initialize`. A 2025-era **stateless HTTP** request carries none after `initialize`, so it is never offered a view (it keeps
  the text result), and a 2026-07-28 client over stdio is not offered one yet.

## What a view can and cannot do

A view is one static page, the same for everyone. It holds no data and makes no request: the client hands it the tool result
and it draws that result. It cannot call tools, open links, load images, fonts or scripts, use storage or reach the network:
its own Content-Security-Policy is `default-src 'none'` with only its own script and style allowed by hash, and it declares no
network, resource, frame or base domain to the client. Names and labels from Agility are shown as text and never as markup.

## Turning it off

`AB_MCP_APPS=off` removes the `ui://` resources and the tool metadata on every host (stdio, the self-hosted server and the
Worker). The default is on, because it only ever reaches a client that asked for it.

## Status

Verified on fakes and in a real browser engine in a sandboxed frame. Rendering in the real clients (VS Code, Claude) is not
verified yet ([P8-19](../tasks/phase-8-power-features/P8-19-verify-apps-in-real-clients.md)).
