---
id: P8-19
title: "Verify MCP Apps views in real clients"
phase: 8
status: todo
priority: low
depends_on: [P8-03]
adr: ["0015"]
lessons: [L-023, L-425]
owner: ""
---

# P8-19 — Verify MCP Apps views in real clients

## Goal
Know whether the sprint burndown and status distribution views render in the clients that claim MCP Apps, and fix what they
get wrong. P8-03 verified the views on fakes and in a sandboxed Chromium frame only (L-023: an SDK or a browser engine is not a
client).

## Scope
- Run `get_sprint` (burndown) and `sprint_health` (status distribution) against a tenant from VS Code (Copilot) and Claude
  (Desktop or web), over stdio where the client supports it and over HTTP with a 2026-07-28 client.
- Record in `docs/reference/client-compatibility.md`: whether the view was offered, rendered, resized, themed (light and dark)
  and whether the client applied its own policy on top of the page's.
- Fix or file what breaks: host theme variables, the size notification, a host that wants a different handshake message.
- Decide whether a 2026-07-28 client over stdio should be offered the views (D-261).

## Acceptance criteria
- [ ] Both views rendered in at least two real clients, with the sprint figures matching the text result.
- [ ] A client that declared Apps and a client that did not got the same text result.
- [ ] The compatibility table and the charts guide say what was verified, with dates and client versions.

## Security notes
THREAT_MODEL T27: confirm that no client policy is looser than the page's own and that a hostile sprint name stays text in each.

## Lessons applied
- L-023 — SDK conformance does not prove client compatibility.
- L-425 — Offer an extension only where the transport can know the client declared it.

## Docs to update
- docs/reference/client-compatibility.md, docs/guide/charts.md

## Out of scope
- New views or interactive features.
