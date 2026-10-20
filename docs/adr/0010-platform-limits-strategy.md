# ADR-0010 — Budgets, concurrency and retries

- **Status:** proposed (pending spikes P0-06 and P0-09)
- **Date:** 2026-10-16
- **Related:** P1-02, P3-03, P6-11, L-047 – L-049, L-079 – L-081, L-097, L-114 – L-116, THREAT_MODEL T5, A10

## Context

Agents can generate many expensive requests. Agility instances enforce tenant-configured quotas (by time window,
request count, response size or **error count**, answered with HTTP 429 and a JSON body whose `RetryAfter` field gives
the wait in seconds), and a burst of invalid requests can lock a token out. Cloudflare's Free plan allows about 10 ms CPU and 50 external subrequests per
request. One agent must not be able to exhaust a customer's Agility tenant.

## Decision

- **Per-call budget** of Agility HTTP requests in every `ToolContext` (each attempt counts, retries included). Presets:
  Node/stdio 1,000; Workers Free 45 (headroom under 50 subrequests); Workers Paid 1,000; overridable with
  `AB_CALL_BUDGET`. Tools declare a worst-case cost; a tool that cannot fit the budget is not registered.
- **Validate before sending.** Queries are checked against the instance metadata and limits server-side, so invalid
  requests do not consume the tenant's error quota.
- **Concurrency**: a per-credential semaphore (default 5) within a process or isolate (≤ 6 on Workers); a deployment-wide
  limiter (Durable Object or storage counters) is optional for reads and required for writes.
- **Retries**: only 429/502/503/504 and network errors on read requests, at most 3 attempts, full-jitter exponential
  backoff starting at 500 ms, honouring the `Retry-After` header or the body's `RetryAfter` field and refusing waits
  above 10 s (the error then reports the wait); never retry writes,
  401/403/404/400. Repeated 429s open a short circuit breaker keyed by instance **and credential** (Agility quotas are per consumer, so
  one member's throttling must not block the others).
- **Response caps**: responses are stream-read with a byte cap before parsing (512 KiB Free, 8 MiB Paid/Node default
  *(re-measure)*), plus output caps (ADR-0015).
- **Deadlines**: per-request upstream timeout (default 20 s), whole MCP exchange 180 s.
- **Rate limits** at our edge: per IP, per auth failure, per token, per grant, per write (P2-07, P7-03). Authorization
  fails closed; cost quotas may fail open with a warning; write limits fail closed.

## Consequences

- Predictable cost per call and clear errors (`AB_BUDGET_EXHAUSTED`, `AB_AGILITY_RATE_LIMITED`).
- The numbers are starting points; P0-06/P0-09 measurements and P3-10/P9-03 benchmarks revise them.

## Evidence (P0-09, 2026-10-20)

From [spikes/workers-limits/RESULTS.md](../../spikes/workers-limits/RESULTS.md): read + parse + shape costs 2.3 ms (p50,
Node) at 512 KiB and about 4.5 ms with the production factor measured on Workers Free, so the **512 KiB Free / 8 MiB
Paid and Node response caps stand**, as do the budget presets. `meta.v1` for a whole instance is 4–5 MB, so on Workers
the metadata service loads one asset type at a time (P1-03). Production numbers with Agility-shaped payloads are the
owner's checklist ([deploy-and-measure.md](../../spikes/workers-limits/deploy-and-measure.md)).

## Alternatives considered

- **Let Agility or the platform fail naturally:** rejected; error-count quotas punish the user's own token.
- **Global limiter only:** rejected; per-credential limits are what protect each member's quota.
