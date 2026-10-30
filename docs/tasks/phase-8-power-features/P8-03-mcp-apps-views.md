---
id: P8-03
title: MCP Apps views
phase: 8
status: review
priority: low
depends_on: [P6-13]
adr: ["0015"]
lessons: [L-016, L-023]
owner: ""
---

# P8-03 — MCP Apps views

## Goal
Charts in clients that support MCP Apps, text everywhere else. Nothing changes for any other client.

## Scope
- Two static views, `ui://agility-bridge/sprint-burndown` and `ui://agility-bridge/status-distribution`
  (`text/html;profile=mcp-app`): one page each, no dependency, no external resource, one inline script and one inline
  style allowed by hash in the page's own Content-Security-Policy (`default-src 'none'`, `connect-src 'none'`, no
  images, frames, objects, forms or base URL) and an empty `_meta.ui.csp` for the host. The page holds no data and makes
  no request: it does the `ui/initialize` handshake and draws the `structuredContent` of the tool result the host gives
  it. Every piece of text, Agility's included, reaches the page through `textContent`; attribute values are fixed words or
  numbers that went through `Number()`.
- A tool names its view (`view` on the definition); `get_sprint` shows the burndown, `sprint_health` the status
  distribution (it gains the sprint's `byStatusCategory` in its structured output). A view is offered only when the caller
  holds a tool that links it.
- Offered only to a client that declared Apps (`capabilities.extensions["io.modelcontextprotocol/ui"].mimeTypes` with the
  HTML profile): per request on 2026-07-28 (from the request's envelope), after `initialize` on a connection that keeps
  its capabilities (stdio). A 2025-era stateless HTTP request carries no capabilities after `initialize`, so it is never
  offered Apps (L-016, L-025) and keeps the text result.
- `AB_MCP_APPS=off` is the kill switch (default `on`): no `ui://` resource, no tool metadata, whatever the client declares.
- Docs: `docs/guide/charts.md` (new), configuration guide, client-compatibility table, tool catalogue.

## Acceptance criteria
- [x] Policy test: each page's CSP allows only its own hashed script and style and no network, image, frame, object,
      form or base URL; the hashes match the exact page text; the page has one script and one style and no element or
      attribute that loads anything.
- [x] The script is pinned by a test: no `innerHTML`, `eval`, `Function`, network, storage, navigation, `href` or `srcdoc`.
- [x] Injection tests on labels: hostile sprint names and category names (markup, script, quotes, bidi, template text)
      appear only as text; no attribute carries them; hostile numbers and dates draw nothing (fake DOM in CI; real
      Chromium in a sandboxed iframe checked by hand, no code ran and no request left the page).
- [x] The handshake is tested: `ui/initialize`, `initialized` after the result, teardown answered, other senders ignored.
- [x] Offered only to a client that declared Apps: 2026-07-28 request with and without the declaration, stdio connection
      with and without it, 2025-era stateless HTTP (never); a caller without the linking tool never sees the resource.
- [x] `AB_MCP_APPS=off` removes the resources and the tool metadata on every host.
- [ ] Rendering verified in at least two real clients (VS Code, Claude) (*unverified*: needs the clients; left for the
      owner and the Phase 8 review's live pass, tracked as [P8-19](P8-19-verify-apps-in-real-clients.md)).

## Security notes
THREAT_MODEL T27.

## Lessons applied
- L-016 — Advertise only what works on that transport.
- L-023 — SDK conformance does not prove client compatibility.

## Docs to update
- docs/guide/charts.md (new)

## Out of scope
- Anything not listed under Scope.
