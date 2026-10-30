# Observability: watching your own deployment

`agility-bridge serve` and the Cloudflare Worker can send one [OpenTelemetry](https://opentelemetry.io) span for every MCP request
to a collector you run, so you can chart latency, error rate and Agility pressure. It is **off by default**, sends nothing
until you set an endpoint, and sends **no content**: no Agility text, no token, no workspace or person, no query, no address.

## Turn it on

| Setting | Meaning |
|---|---|
| `AB_OTEL_ENDPOINT` | The collector's base URL, e.g. `https://otel.example.com` or `http://127.0.0.1:4318`. Spans are posted to `<endpoint>/v1/traces` as OTLP/HTTP JSON. HTTPS only, except loopback; no user name, query or fragment |
| `AB_OTEL_HEADERS` | Optional `name=value,name2=value2` sent with every post, for a hosted collector's API key. **A secret:** never logged, never in any output; on Workers set it as a secret (`wrangler secret put AB_OTEL_HEADERS`). Needs `AB_OTEL_ENDPOINT` |

At start the server logs one warning naming the collector's host (never the path or the headers). Node batches spans and
sends them every five seconds and once more at shutdown; the Worker sends a request's span after the response, so nothing waits
for the collector. A collector that is down, slow or refusing never changes or delays a response: the spans are dropped after
one attempt and a warning (the error class only, at most one a minute) says so. On the Workers Free plan each request makes one
more outgoing request for its span (45 Agility requests plus one is under the 50 allowed).

**Unauthenticated traffic is sampled.** A request that never authenticated (a 401, a 429 from the address limiter, or the
[public catalogue](self-hosting.md#public-tool-catalogue-optional)) is recorded as a span at most 30 times a minute per
process or isolate; the rest are counted and not sent, so anyone who can reach the server cannot set the volume of the
collector's bill or of the Worker's outgoing requests. Every authenticated request still has its span. A caller's
`traceparent` is used only for authenticated requests, so a caller can attach a span to a trace id of their choosing (the span
carries only the attributes below); it is never forwarded to Agility.

**The collector is your choice.** `AB_OTEL_ENDPOINT` is operator configuration, not caller input, so it is not held to the
public-address rule other outgoing requests follow: an internal collector (a private address or an internal name) is a normal
target. Set it only to a collector you trust; it receives the attributes below and the `AB_OTEL_HEADERS` credential.

stdio is not instrumented: it is a local process for one person, and the client already shows what it does
([P8-20](../tasks/phase-8-power-features/P8-20-stdio-telemetry.md)).

## What a span is

One span per MCP request, for every method (`initialize`, `server/discover`, `ping`, `tools/list`, `tools/call`, prompts,
resources, completion, `subscriptions/listen`, tasks, notifications), and for a request refused before any method ran. It ends
when the exchange ends, so a streamed answer has its real duration. The name is the method, plus the tool for a tool call
(`tools/call get_sprint`).

| Attribute | Values |
|---|---|
| `mcp.method.name` | A known MCP method, or `other` (a request refused before its body was read, or a method we do not know) |
| `agility_bridge.method_class` | `tool_call`, `list`, `read`, `lifecycle`, `notification`, `listen`, `task`, `response`, `other` |
| `gen_ai.tool.name` | A registered tool name, or `unknown`; only on `tools/call` |
| `http.response.status_code` | The HTTP status of the answer |
| `agility_bridge.outcome` | `ok`, `refused` (401, 403, 400, 405, 413, 415), `rate_limited` (429), `failed` |
| `agility_bridge.fault` | `none`, `caller`, `upstream`, `server` (below) |
| `error.type` | One of our stable `AB_*` error codes, or `http_4xx` / `http_5xx` |
| `agility_bridge.refusal` | Our own short reason for a refusal before a tool: `no_token`, `token_malformed`, `rate_limited`, `body`, `method`, `unavailable`, `deadline`, … |
| `agility_bridge.requests` | Agility requests the call used (a count) |
| `agility_bridge.request_id` | The request id that is also in the logs |
| resource: `service.name`, `service.version`, `deployment.environment.name` | `agility-bridge`, the version, `production` or `test` |

That is the whole list. There is no way to add an attribute from a tool, a workspace or a setting: every span passes through one
function that keeps these keys and checks each value's shape. Not exported, by design: workspace, user, grant, device, token,
client address, arguments, queries, URIs, prompt names, asset text or numbers, error messages, member emails.

## Error rate: whose fault is it?

A bad asset number is not an outage. Every failure is classed (the class is `agility_bridge.fault`), and the span status is
`ERROR` only for the last two:

| Fault | What it is | Examples (`error.type`) | Span status |
|---|---|---|---|
| `none` | It worked | | unset |
| `caller` | The request is wrong, not allowed, or over a limit we set | `AB_INPUT_INVALID`, `AB_NOT_FOUND`, `AB_AUTH_FORBIDDEN`, `AB_LIMIT_RATE`, `AB_BUDGET_EXHAUSTED`, `AB_AGILITY_AUTH` (their own Agility token was refused), a refused or declined write, a `401` or `429` at the door | unset |
| `upstream` | Agility did not deliver | `AB_AGILITY_RATE_LIMITED`, `AB_AGILITY_TIMEOUT`, `AB_AGILITY_UNAVAILABLE`, `AB_AGILITY_TLS`, `AB_AGILITY_ERROR` | `ERROR` |
| `server` | Ours | `AB_INTERNAL`, `AB_WRITE_AUDIT_UNAVAILABLE`, `AB_WRITE_LIMIT_UNAVAILABLE`, a wrong instance URL, any `5xx` (`503` storage down, `504` deadline), and any code this table does not know yet | `ERROR` |

Split `upstream` from `server` in a dashboard: an Agility outage and a bug in this server need different people.

## Trace context

A request may carry a W3C `traceparent`. It is read strictly (`00-<32 hex>-<16 hex>-<2 hex>`, lower-case, no all-zero ids, nothing
after the flags; anything else is ignored and a new trace starts) and **only on an authenticated request**, so an anonymous caller
cannot put its own trace ids into your data. `tracestate` and `baggage` are never read. Trace headers are never sent to Agility
(the Agility client builds its own headers), and none is returned to the caller. Sampling is ours: every request is exported.

## Recipes

These use the OpenTelemetry Collector's `spanmetrics` connector to turn spans into metrics, then Prometheus rules. They were
written against the attribute list above and the span data was checked against a fake collector; they have **not** been run
against a real Prometheus or Grafana (*unverified*).

```yaml
# otel-collector.yaml
receivers:
  otlp:
    protocols:
      http: { endpoint: 0.0.0.0:4318 }
connectors:
  spanmetrics:
    histogram:
      explicit: { buckets: [50ms, 200ms, 1s, 5s, 20s, 60s] }
    dimensions:
      - name: mcp.method.name
      - name: gen_ai.tool.name
      - name: agility_bridge.fault
      - name: agility_bridge.outcome
      - name: error.type
exporters:
  prometheus: { endpoint: 0.0.0.0:9464 }
service:
  pipelines:
    traces: { receivers: [otlp], exporters: [spanmetrics] }
    metrics: { receivers: [spanmetrics], exporters: [prometheus] }
```

The `spanmetrics` connector writes `traces_span_metrics_calls_total` and `traces_span_metrics_duration_milliseconds_*`, with the
dimensions as labels (dots become underscores):

```promql
# Service error rate (server and upstream faults): never caller faults
sum(rate(traces_span_metrics_calls_total{status_code="STATUS_CODE_ERROR"}[5m]))
  / sum(rate(traces_span_metrics_calls_total[5m]))

# Only our own faults
sum(rate(traces_span_metrics_calls_total{agility_bridge_fault="server"}[5m]))

# Agility pressure: throttling and slowness
sum(rate(traces_span_metrics_calls_total{error_type="AB_AGILITY_RATE_LIMITED"}[5m]))
sum(rate(traces_span_metrics_calls_total{agility_bridge_fault="upstream"}[5m]))

# p95 latency of tool calls, per tool
histogram_quantile(0.95, sum by (le, gen_ai_tool_name) (rate(traces_span_metrics_duration_milliseconds_bucket{agility_bridge_method_class="tool_call"}[5m])))

# Callers hitting our limits, and refused requests (a spike is a leaked or expired token, or a scan)
sum(rate(traces_span_metrics_calls_total{agility_bridge_outcome="rate_limited"}[5m]))
sum(rate(traces_span_metrics_calls_total{agility_bridge_outcome="refused"}[5m]))
```

```yaml
# prometheus-rules.yaml
groups:
  - name: agility-bridge
    rules:
      - alert: AgilityBridgeServerFaults
        expr: sum(rate(traces_span_metrics_calls_total{agility_bridge_fault="server"}[10m])) > 0.05
        for: 10m
        annotations: { summary: "agility-bridge is failing on its own (AB_INTERNAL, storage, deadline)" }
      - alert: AgilityUnavailable
        expr: |
          sum(rate(traces_span_metrics_calls_total{agility_bridge_fault="upstream"}[10m]))
            / sum(rate(traces_span_metrics_calls_total{agility_bridge_method_class="tool_call"}[10m])) > 0.2
        for: 10m
        annotations: { summary: "More than 20% of tool calls fail because Agility does not answer" }
      - alert: AgilityThrottling
        expr: sum(rate(traces_span_metrics_calls_total{error_type="AB_AGILITY_RATE_LIMITED"}[10m])) > 0
        for: 15m
        annotations: { summary: "Agility is rate limiting this deployment's tokens: lower AB_CALL_BUDGET or spread the callers" }
      - alert: AgilityBridgeSlowToolCalls
        expr: |
          histogram_quantile(0.95, sum by (le) (rate(traces_span_metrics_duration_milliseconds_bucket{agility_bridge_method_class="tool_call"}[10m]))) > 20000
        for: 15m
        annotations: { summary: "p95 tool call latency above 20 s (the Agility request timeout)" }
```

A dashboard needs five panels: request rate by `mcp.method.name`; service error rate (first query); faults by
`agility_bridge.fault`; p50 and p95 latency by tool; Agility requests per call (the `agility_bridge.requests` attribute on spans, in
a trace backend rather than as a metric label, since it is a number, not a category).

## Not covered

- Metrics and logs over OTLP: the backend derives metrics from spans (above), and logs stay on stderr, redacted.
- Per-workspace views. A workspace id is not exported; if you need it, the audit log has it per request id
  (`agility_bridge.request_id` is the join key).
- A tool that fails inside a `200` JSON-RPC error before it runs (an unknown tool name, an invalid `tools/call` envelope) is a
  successful span: the answer was `200`.
