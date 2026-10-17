---
id: P1-02
title: Agility HTTP client (instances, auth, retries, limiter, budget)
phase: 1
status: todo
priority: high
depends_on: [P1-01]
adr: ["0010", "0011", "0014"]
lessons: [L-046, L-047, L-048, L-049, L-054, L-055, L-138, L-140, L-152]
owner: ""
---

# P1-02 — Agility HTTP client (instances, auth, retries, limiter, budget)

## Goal
One client that every tool uses to talk to Agility safely: canonical instance URLs, one identity per call, bounded retries, concurrency, budgets, byte caps and precise errors.

## Scope
- Canonical instance URL: HTTPS only (HTTP for loopback tests), no user info, query or fragment, path preserved, no trailing slash.
- Request builders for `query.v1` (POST JSON), `meta.v1` (GET), `rest-1.v1` (GET/POST XML) and `api/asset` (POST JSON).
- Headers: `Authorization: Bearer`, `Accept`, `User-Agent: agility-bridge/<version>`.
- Redirects handled manually and refused (`AB_AGILITY_WRONG_INSTANCE`); HTML login pages detected.
- Timeouts; retries per ADR-0010 for reads only, honouring `Retry-After` and the 429 body's `RetryAfter`; circuit breaker keyed by instance and credential.
- Per-credential semaphore; budget charged per attempt.
- Byte-capped streaming reader; JSON parsing; XML parsing with the parser chosen in P0-09 (entities disabled).
- Error mapping table of ARCHITECTURE §6.1; injectable `fetch` and (Node) dispatcher for custom CA bundles.

## Acceptance criteria
- [ ] Tests with an injected `fetch` for every row of the error-mapping table.
- [ ] Retry tests: header and body `RetryAfter`, waits above 10 s refused, no retry on POST, budget exhaustion during retries → `AB_BUDGET_EXHAUSTED`.
- [ ] Redirect refusal, byte cap, concurrency limit and circuit breaker tested (one credential's 429s never block another).
- [ ] A 404 message says "not found or not visible with this token".
- [ ] The Node app wires a CA bundle into the dispatcher (integration test with a local TLS server and a private CA).
- [ ] No log line contains the token (redaction test on debug output).

## Security notes
THREAT_MODEL T5, T8, T12, A9, A10.

## Lessons applied
- L-046 — Classify errors precisely.
- L-047 — Retry only what is safe to retry.
- L-048 — Stay well under the provider's concurrency.
- L-049 — Cap bytes before parsing.
- L-054 — The instance is first-class configuration.
- L-055 — Credentials never follow redirects, and the upstream URL never comes from a request.
- L-138 — Validate before sending; quotas can count errors.
- L-140 — A 404 means "not found or not visible".
- L-152 — One identity per tool call.

## Docs to update
- docs/ARCHITECTURE.md §6.1

## Out of scope
- Metadata and query compilation (P1-03, P1-04)
