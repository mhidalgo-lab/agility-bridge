---
id: P9-28
title: Worker log levels and Workers Logs in the committed config
phase: 9
status: review
priority: medium
depends_on: []
lessons: [L-117, L-508]
owner: "claude (agent)"
---

# P9-28 — Worker log levels and Workers Logs in the committed config

## Goal
The production Worker's dashboard shows real errors only, and Workers Logs is part of the deployment's code rather than a
dashboard switch. On 2026-11-19 the owner turned on Workers observability: within minutes it counted 17 errors and opened 6
issues, yet every request answered 200 and every flagged line was an `info` record (`booted`, `request`, `scheduled jobs`).
The Worker's logger wrote every line with `console.error`, and Workers Logs files a line by the console method that wrote it.

## Scope
- `LogSink` receives the record's level; new `consoleLevelSink` in core writes `debug`/`info`/`warn`/`error` with the
  matching console method. The Worker uses it; Node (`serve`, stdio) keeps `stderrSink` (stdout is the MCP channel).
- `apps/worker/wrangler.jsonc` gains the `observability` block: logs (invocation logs, persisted), traces and issues on,
  sampling 1, `redact_query_string: true` (sign-in and OAuth callbacks carry codes in the query). `cf:setup` copies it into
  each deployment's local config.

## Acceptance criteria
- [x] Each level reaches its own console method through `consoleLevelSink`; `stderrSink` still writes every level to
      `console.error` (tests).
- [x] The logger passes the level to the sink (test).
- [x] `cf:setup`'s generated config carries the observability block with `redact_query_string` (test); `wrangler deploy
      --dry-run` accepts the config without warnings.
- [x] Live (2026-11-19, before the change): Cloudflare masks `Authorization` in invocation logs; outgoing spans carry no
      query string; D1 spans hold SQL with placeholders only.
- [x] THREAT_MODEL T8, the observability guide and L-508 updated; changeset added.

## Security notes
THREAT_MODEL T8: invocation records, log lines and spans are kept at Cloudflare. Query strings are dropped from logged
URLs; Cloudflare masks `Authorization`, `Cookie` and key-, secret- and token-named headers; our lines are redacted JSON.

## Lessons applied
- L-117 — the lines that reach Workers Logs are the redacted JSON records; only their console method changes.
- L-508 — on Workers the console method is the level.

## Docs to update
- `docs/guide/observability.md`, `docs/THREAT_MODEL.md`, `docs/LESSONS-LEARNED.md`.

## Out of scope
- Sampling below 1 or Logpush destinations (Free plan: 200,000 events a day; one request is a few events).
- The boot-failure line in `apps/worker/src/index.ts`, which is an error and stays on `console.error`.
