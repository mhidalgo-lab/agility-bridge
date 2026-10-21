---
id: P2-08
title: Audit log
phase: 2
status: done
priority: high
depends_on: [P2-06]
adr: ["0008"]
lessons: [L-015, L-101, L-109, L-117]
owner: "Matias Hidalgo"
---

# P2-08 — Audit log

## Goal
Who did what, through which grant and device, against which assets — without storing content or secrets.

## Scope
- Rows for tool calls, refusals and admin changes (fields in ARCHITECTURE §4), written in the background; failures logged, never surfaced.
- Masked compiled queries (values removed), asset numbers (bounded), Agility request counts, durations, error codes.
- Retention (default 90 days, `0` = forever) with startup and hourly purge; refusal rows capped per minute with a summary row.
- A synchronous intent-write API reserved for write tools (P7-01).

## Acceptance criteria
- [x] No token, credential, request body or Agility content in any row (scan test). *(After tool calls with a
  filter value, refusals with a request body and an admin row: device tokens, Agility tokens, the filter value, project,
  member and story names and `Bearer` are absent.)*
- [x] Retention purge tested; refusal flood capped. *(Batches of 1,000; `0` keeps everything; 60 refusal rows a
  minute and a summary row.)*

## Notes
- `packages/http-app/src/audit.ts`: `AuditWriter` (background queue, bounded; `toolCall`, `request` (refusals 401/429),
  `admin`, `writeIntent` (synchronous, throws), `flush`, `observer()`), `purgeAudit`, `scheduleAuditRetention`.
- Core's `ToolCallEvent` gained `assetNumbers` and `queries`, taken by `auditFacts` from the tool's own result (row
  `number` fields; `_meta["agility-bridge/result"].query(ies)`, already masked by the compiler).
- `serve` writes audit rows, purges at start and hourly (`AB_AUDIT_RETENTION_DAYS`) and flushes on shutdown. Admin
  changes are recorded by the admin API and CLI (P2-09, P2-10) through `AuditWriter.admin`.
- A refused request's body is never read, so refusal rows carry no MCP method.

## Security notes
THREAT_MODEL T8, T17.

## Lessons applied
- L-015 — Classify every MCP method, not only `tools/call`.
- L-101 — Count budgets in audit records, not headers.
- L-109 — Audit the intent before the mutation.
- L-117 — Redaction is broad and tested.

## Docs to update
- [x] docs/guide/audit-log.md (new)
- docs/security/logging.md (P2-15)

## Out of scope
- Anything not listed under Scope.
