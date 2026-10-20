---
id: P7-01
title: Write framework (enablement, approval, dry run, audit intent)
phase: 7
status: todo
priority: high
depends_on: [P2-17, P0-07]
adr: ["0013", "0008"]
lessons: [L-025, L-105, L-106, L-107, L-108, L-109, L-110, L-022, L-154]
owner: ""
---

# P7-01 — Write framework (enablement, approval, dry run, audit intent)

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
One pipeline that every write tool uses, so no write can skip enablement, approval, re-checks or audit.

## Scope
- Enablement layers: `AB_WRITE_TOOLS`, workspace and grant tool lists naming the tool, personal credential, OAuth `mcp:write` when OAuth is on; owner-only changes.
- Canonical mutation (one target, explicit fields, old → new) and the pipeline of ARCHITECTURE §6.6.
- `dry_run`, `confirm`, elicitation approval (stdio and 2026-07-28 requests), approval ledger (hash of canonical mutation + actor + target + expiry, single use), refusal errors (`AB_WRITE_APPROVAL_UNAVAILABLE`, `AB_WRITE_APPROVAL_DECLINED`, `AB_WRITE_CONFLICT`).
- Durable intent audit before sending; outcome audit after; no retries; read-lag note.
- `whoami` and dry runs report the approval channel available to this client.
- Check the request's declared elicitation capability **before** asking for approval: on 2026-07-28 the SDK turns an
  `inputRequired(...)` sent to a client without the capability into a protocol error, so the framework returns its own
  `AB_WRITE_APPROVAL_UNAVAILABLE` tool error instead (P0-07 finding 7).
- Approval state per runtime (ADR-0013): `kv` ledger and durable intent audit in remote modes; in stdio an in-process ledger, HMAC-protected multi round-trip state and intent/outcome logged to stderr. `AB_WRITE_APPROVAL=off` only in stdio mode, pending D-10.
- `tools/list` budget test with the write group enabled.

## Acceptance criteria
- [ ] Tests: every layer missing → tool absent; shared credential → never writes; approval replay refused; approval for a different target or value refused; intent-audit failure → refused; refusals are errors.
- [ ] Approval text shows the full change; oversized approvals refused rather than truncated.

## Security notes
THREAT_MODEL T17, T31, A2, A6.

## Lessons applied
- L-025 — Not every client can answer an approval prompt.
- L-105 — Writes are a separate product.
- L-106 — Approval shows and binds the complete change.
- L-107 — `confirm: true` is not human approval.
- L-108 — Validate fully, then ask, then re-check, then apply once.
- L-109 — Audit the intent before the mutation.
- L-110 — Dry runs are complete.
- L-022 — Budget the `tools/list` payload.
- L-154 — Annotations are hints that most clients ignore.

## Docs to update
- docs/guide/write-tools.md (new)
- docs/THREAT_MODEL.md

## Out of scope
- Anything not listed under Scope.
