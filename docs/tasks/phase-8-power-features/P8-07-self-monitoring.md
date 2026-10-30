---
id: P8-07
title: Self-monitoring with OpenTelemetry
phase: 8
status: in-progress
priority: low
depends_on: [P6-13]
adr: []
lessons: [L-015, L-118, L-119]
owner: ""
---

# P8-07 — Self-monitoring with OpenTelemetry

## Goal
Operators can watch latency, errors and Agility pressure of their own deployment in any OpenTelemetry backend, without a
single piece of Agility content, credential or caller value leaving the server.

## Scope
- Opt-in OTLP/HTTP export (JSON), off by default: `AB_OTEL_ENDPOINT` (HTTPS, or HTTP on loopback; no user info, query or
  fragment) and optional `AB_OTEL_HEADERS` (`name=value,…`, a secret: never logged, never in any output). A shared server
  setting, so `serve` and the Worker read it the same way; warned at start with the host only.
- One span per MCP request on the HTTP hosts, for **every** method (L-015): `initialize`, `server/discover`, `ping`,
  `tools/list`, `tools/call`, prompts, resources, completion, `subscriptions/listen`, tasks, notifications, and requests
  refused before any method runs (no token, rate limit, bad body). It ends when the exchange ends, so a streamed answer
  has its real duration. stdio is not instrumented here (a local single-user process; follow-up task).
- **Allowlisted attributes only** (L-119), enforced in one function that every span passes through: `mcp.method.name`
  (a known MCP method or `other`), `agility_bridge.method_class`, `gen_ai.tool.name` (only a registered tool name),
  `http.response.status_code`, `agility_bridge.outcome`, `agility_bridge.fault`, `error.type` (one of our stable `AB_*`
  codes), `agility_bridge.refusal` (a short code from our own vocabulary), `agility_bridge.requests` (Agility requests the
  call used), `agility_bridge.request_id` (our own id, the one in the logs), and the resource's `service.name`,
  `service.version`, `deployment.environment.name`. Nothing else: no workspace, user, grant, device or token id, no address,
  no argument, query, URI, prompt name, asset text, number or error message.
- **Caller faults are not service errors** (L-118): a fault is `none`, `caller` (bad input, not found, not allowed, rate
  limited by us, approval declined), `upstream` (Agility down, slow, throttling or erroring) or `server` (ours). The span
  status is `ERROR` for `server` and `upstream` only, so an error-rate alert is not tripped by a bad asset number, and an
  Agility outage still shows.
- **Strict `traceparent`** (W3C Trace Context): parsed field by field; honoured only on an authenticated request; anything
  malformed starts a new trace; `tracestate` and `baggage` are ignored. Nothing is ever sent to Agility with trace
  headers (the Agility client builds its own headers), and nothing is returned to the caller.
- Export never affects a request: bounded queue, short timeout, failures counted and logged as a class only, never a retry
  storm. On Workers each request flushes its own spans through `waitUntil`; on Node spans are batched and flushed on a timer
  and at shutdown.
- Docs: `docs/guide/observability.md` (new) with the span reference, error-rate semantics, and recipes for dashboards and
  alerts; configuration guide; THREAT_MODEL T30; `docs/security/logging.md` for the new log lines.

## Acceptance criteria
- [ ] Attribute allowlist test: hostile and extra attributes (workspace, user, token, query, URI, message) are dropped;
      every value is validated by type and shape; the payload of a full run contains none of the secrets or content used.
- [ ] Error-rate semantics verified end to end with a local fake collector (a real HTTP server receiving OTLP/JSON): caller
      faults, upstream faults and server faults classified as above, and the error rate computed from the received spans
      counts only the last two.
- [ ] Every MCP method and every early refusal produces one span (table test over the method classes).
- [ ] `traceparent`: strict parsing (version, lengths, hex case, all-zero ids, extra fields), joined only when
      authenticated, never present on a request to Agility, never returned.
- [ ] Off by default: no exporter, no request to any endpoint; a collector that is down, slow or answering errors never
      changes or delays a response.
- [ ] Settings validated (`AB_OTEL_ENDPOINT`, `AB_OTEL_HEADERS`), secret never echoed; guide and recipes written.

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
