---
"agility-bridge": minor
---

Self-monitoring with OpenTelemetry (P8-07): `AB_OTEL_ENDPOINT` (and optionally `AB_OTEL_HEADERS`) makes `serve` and the Worker send one span per MCP request to your OTLP/HTTP collector, off by default. Spans carry only an allowlist of attributes (MCP method, tool name, status, error code, fault class, duration, Agility request count, request id), never Agility content, credentials, people, workspaces or query values. Caller faults are never counted as service errors. `traceparent` is read strictly, only from authenticated callers, and never forwarded to Agility. See the observability guide for the span reference and dashboard and alert recipes.
