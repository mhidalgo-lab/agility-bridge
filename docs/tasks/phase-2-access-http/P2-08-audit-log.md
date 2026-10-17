---
id: P2-08
title: Audit log
phase: 2
status: todo
priority: high
depends_on: [P2-06]
adr: ["0008"]
lessons: [L-015, L-101, L-109, L-117]
owner: ""
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
- [ ] No token, credential, request body or Agility content in any row (scan test).
- [ ] Retention purge tested; refusal flood capped.

## Security notes
THREAT_MODEL T8, T17.

## Lessons applied
- L-015 — Classify every MCP method, not only `tools/call`.
- L-101 — Count budgets in audit records, not headers.
- L-109 — Audit the intent before the mutation.
- L-117 — Redaction is broad and tested.

## Docs to update
- docs/guide/audit-log.md (new)
- docs/security/logging.md (P2-15)

## Out of scope
- Anything not listed under Scope.
