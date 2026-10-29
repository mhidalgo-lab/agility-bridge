---
id: P7-11
title: Write rows in the audit viewer, CSV and statistics
phase: 7
status: done
priority: low
depends_on: [P7-01, P4-05]
adr: ["0013"]
lessons: [L-109, L-125]
owner: ""
---

# P7-11 — Write rows in the audit viewer, CSV and statistics

> Filed by P7-01 ([write framework](P7-01-write-framework.md)). Refine scope and acceptance criteria before starting.

## Goal
People can read what was written: intent and outcome of every write, paired, in the panel and the CSV export.

## Scope
Refined 2026-10-29 (a write is two `write` rows that share `details.intentId`: the outcome's `intentId` is the intent row's id; both carry `details.phase`, `operation`, `hash`, `fields` (names only), `approval` and the same request id).

- **Viewer** (`/admin/audit`): the Action cell of a write row shows its phase and operation; the Result cell shows target, field names, approval channel and the short hash. Each row is paired inside the rows of the page: an intent says "outcome: ok/error <code>" or "no outcome recorded"; an outcome says "of intent ...". At a page edge the partner can be on the neighbouring page, and the row says so instead of claiming a missing outcome. An intent younger than 10 minutes is "in progress", older with no outcome is **flagged** (a crash between intent and outcome, or an outcome that could not be stored). The existing `kind` and `action` filters already select writes; no storage change.
- **CSV**: columns `write_phase`, `write_operation`, `write_approval`, `write_hash`, `write_fields`, `write_intent_id`, `write_pair` (`outcome_found`, `outcome_missing`, `intent_found`, `intent_outside_export`, `in_progress`), empty for other kinds. No value exists in a row to leak (D-160).
- **Statistics**: `GET /api/admin/v1/audit/write-stats` (owner and admin; a member is refused like `/audit/stats`) counts writes by tool, approval channel and outcome (`ok`, `error`, no outcome) and lists the unpaired intents (at most 20). It reads the newest 3,000 `write` rows of the window (three queries, no new index) and says when it stopped there. The Usage page shows it under the tool-call table.
- A member still sees only their own rows: write rows carry the grant's user id, so the scope rule of `GET /audit` applies unchanged.
- Out of scope here: a filter on `details` (needs a storage column or JSON index), the CLI (`audit tail` already prints write rows).

## Acceptance criteria
- [x] Viewer, CSV and statistics tests with intent-only, intent+ok and intent+error pairs.
- [x] A member sees only their own write rows (same scope rule as tool calls); a member is refused the write statistics and nothing is read.
- [x] The audit guide describes the pair and what an unpaired intent means.
- [x] Hostile strings in a write row's fields, target and tool stay inert on the page and in the CSV.

## Security notes
THREAT_MODEL T17.

## Lessons applied
- L-109 — Audit the intent before the mutation.
- L-125 — Keep live-verification evidence and recipes.

## Docs to update
- docs/guide/audit-log.md
- docs/guide/admin-panel.md

## Out of scope
- Anything not listed under Scope.
