---
id: P8-20
title: "Self-monitoring for the stdio server"
phase: 8
status: todo
priority: low
depends_on: [P8-07]
adr: []
lessons: [L-118, L-119]
owner: ""
---

# P8-20 — Self-monitoring for the stdio server

## Goal
Let someone who runs the local stdio server watch it in their own collector, with the same attribute list and fault classes as the
HTTP hosts, if anyone asks for it. P8-07 covers `serve` and the Worker only (D-268).

## Scope
- The same `Telemetry` behind the stdio `onToolCall` and a per-request hook for the other methods the SDK serves, with
  `AB_OTEL_ENDPOINT` and `AB_OTEL_HEADERS` read like the other stdio settings (names already known to the loader).
- stdout stays MCP frames only (L-021); a failed export logs to stderr like everything else.

## Acceptance criteria
- [ ] Someone asked for it, and the request says which collector they use.
- [ ] Every stdio method produces one span with the HTTP list of attributes and nothing else; the allowlist test covers it.
- [ ] A collector that is down never blocks a tool call or writes to stdout.

## Security notes
THREAT_MODEL T30: the same allowlist; stdio has no workspace or token to leak, but the arguments and Agility text are as private as on a server.

## Lessons applied
- L-118 — Separate caller faults from server faults.
- L-119 — Instrument every MCP method with allowlisted attributes only.

## Docs to update
- docs/guide/observability.md, docs/guide/configuration.md

## Out of scope
- Metrics or logs over OTLP.
