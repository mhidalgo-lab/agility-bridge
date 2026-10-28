---
id: P4-36
title: Write the audit row before an admin change and refuse the change without it (if D-57 chooses it)
phase: 4
status: dropped
priority: low
depends_on: [P4-09]
adr: ["0013"]
lessons: [L-065, L-109, L-238]
owner: ""
---

# P4-36 — Write the audit row before an admin change and refuse the change without it (if D-57 chooses it)

> **Dropped 2026-10-28:** D-57 chose (a): audit rows stay after the change. Reopen if storage failures that lose audit rows are seen in practice.

> Found by the Phase 4 admin security review (P4-09, decision D-57). Not started.

## Goal
No change to users, roles, credentials, grants, workspaces, instances or tokens happens without an audit row that could be
stored, as the intent of an Agility write already works (L-109).

## Scope
- The admin API writes an `admin` row with status `intent` through `AuditWriter.writeIntent` before the handler runs, and an
  outcome row after it; a failed intent write answers `503` and changes nothing. The break-glass token and the local CLI
  client keep today's behaviour (an audit outage must not lock out incident response), with a loud log line.
- Account for the extra D1 writes per change (Workers Free quota; measured with the benchmark scenarios).

## Acceptance criteria
- [ ] With storage failing on `audit.append`, a session-authenticated change answers `503` and the record is unchanged; the
      break-glass change goes through and is logged.
- [ ] Rows still say what changed (L-238); the audit viewer shows intent and outcome without doubling every line.

## Security notes
THREAT_MODEL T14, T17 (audit completeness).

## Lessons applied
- L-065, L-109, L-238.

## Docs to update
- Audit log guide, THREAT_MODEL T17, Cloudflare limits guide (writes per change).

## Out of scope
- Tool-call and refusal rows (they stay best effort).
