---
id: P8-07
title: Self-monitoring with OpenTelemetry
phase: 8
status: todo
priority: low
depends_on: [P6-13]
adr: []
lessons: [L-015, L-118, L-119]
owner: ""
---

# P8-07 — Self-monitoring with OpenTelemetry

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Operators can watch latency, errors and Agility quota pressure without leaking content.

## Scope
- Opt-in OTLP/HTTP export; spans for every MCP method; allowlisted attributes only; caller vs server fault classification; strict `traceparent` handling, never forwarded to Agility; recipes for dashboards and alerts.

## Acceptance criteria
- [ ] Attribute allowlist test; error-rate semantics verified end to end with a collector.

## Security notes
THREAT_MODEL T30.

## Lessons applied
- L-015 — Classify every MCP method, not only `tools/call`.
- L-118 — Separate caller faults from server faults.
- L-119 — Instrument every MCP method with allowlisted attributes only.

## Docs to update
- docs/guide/observability.md (new)

## Out of scope
- Anything not listed under Scope.
