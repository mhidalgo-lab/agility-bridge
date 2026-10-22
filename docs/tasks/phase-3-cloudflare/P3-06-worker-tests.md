---
id: P3-06
title: Worker test suite (workerd)
phase: 3
status: review
priority: medium
depends_on: [P3-02]
adr: []
lessons: [L-121, L-123, L-179]
owner: ""
---

# P3-06 — Worker test suite (workerd)

> Refined 2026-10-22 (tasks/README rule 7).

## Goal
Everything that runs on Workers is tested on workerd, not only on Node.

## Scope
- **Approach**: the tests run in Node and drive the **bundled** Worker in workerd through Miniflare (the bundle CI
  builds), with a local D1 opened from Node as well for setting up and inspecting state. The Vitest Workers pool is not
  used: `@cloudflare/vitest-pool-workers` 0.23 requires Vitest 4 and the repository is on Vitest 5 (strict peer
  dependencies). Already on workerd from P3-01–P3-04: MCP, admin API, boot, plan presets, rate-limit bindings, the
  storage contract on D1.
- **Authorization matrix on workerd** (P2-12): every denied principal (no, malformed, unknown, other workspace's,
  revoked, expired token; unknown workspace; revoked or expired grant; disabled workspace, user or instance; revoked or
  unvalidated credential) × `initialize`, `tools/list` and every tool: `401`, one body, no Agility request, no change
  to the database, an `auth` audit row with the right reason, no `tool_call` row.
- **Audit through `waitUntil`** and **client address**: refusal rows carry `CF-Connecting-IP`; tool-call rows are
  written after the response.
- **Isolation**: every test gets its own Miniflare and database (no shared state between tests).

## Acceptance criteria
- [x] The workerd suites run in CI (the Linux test job), each test on its own database.
- [x] The P2-12 denial matrix passes on workerd with zero Agility requests per denial.
- [x] `docs/dev/testing.md` explains how the Worker is tested and why not the pool.

## Security notes
THREAT_MODEL T2, T3, T15, T19, T21.

## Lessons applied
- L-121 — Negative authorization is first-class.
- L-123 — Make property tests meaningful and deterministic.
- L-179 — Local workerd does not catch shared in-flight work: test the rule where it is made.

## Docs to update
- docs/dev (testing)

## Out of scope
- A Durable Object simulator (P3-12); remote staging runs (P3-11).
