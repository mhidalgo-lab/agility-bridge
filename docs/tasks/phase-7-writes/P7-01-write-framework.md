---
id: P7-01
title: Write framework (enablement, approval, dry run, audit intent)
phase: 7
status: review
priority: high
depends_on: [P2-17, P0-07]
adr: ["0013", "0008"]
lessons: [L-025, L-105, L-106, L-107, L-108, L-109, L-110, L-022, L-154]
owner: "claude"
---

# P7-01 — Write framework (enablement, approval, dry run, audit intent)

> Scope refined 2026-10-29 (tasks/README rule 7): the framework is built and tested on fakes with a test-only write
> tool; the real tools are P7-04 – P7-06, the approval page P7-02, the limiter P7-03, the sandbox run P7-07.

## Goal
One pipeline that every write tool uses, so no write can skip enablement, approval, re-checks or audit.

## Scope
- **`defineWriteTool(spec)`** (core `writes/`): the only way to make a `write` or `destructive` tool; the registry refuses
  any other. A tool declares its typed input, its field allowlist per asset type, `plan` (validate, resolve, build the
  canonical mutation), an optional `reread` (the target's current values) and `send` (the one mutation). The framework
  adds `dry_run` and `confirm` to the input and owns everything between.
- **Enablement layers** re-asserted inside the handler (defence in depth, besides the access layer that already hides the
  tool): `AB_WRITE_TOOLS` (a write runtime exists), the workspace and grant tool lists (`runtime.tools` and
  `grantedTools` name the tool), a personal credential, OAuth `mcp:write` (the access layer's `writeTools`). A missing layer
  means the tool is not registered for the caller and, if called anyway, `AB_TOOL_DISABLED` with no upstream call.
  Hosts: HTTP selects write tools only for `access.writeTools`; stdio only with `AB_WRITE_TOOLS=on`.
- **Canonical mutation**: one target (`assetType`, `oid`, `number`), at least one change `{ field, old, new }`, unique
  fields from the allowlist, bounded size; a stable JSON form and a SHA-256 hash over it plus the actor and the tool.
- **Pipeline** (ARCHITECTURE §6.6): enablement → plan → dry run → `confirm` → limiter seam (P7-03) → approval → re-read
  (conflict / idempotent no-op) → durable intent audit → single send → outcome audit.
- **Approval**: the exact change rendered in full (target, every field, old → new; Agility text in the untrusted-data
  envelope, values JSON-quoted); an oversized change is refused, never truncated. Channels behind one port: elicitation
  now (2026-07-28 `input_required` with HMAC-sealed request state, 2025-era push elicitation on stdio), a seam for P7-02's
  page. The request's declared capability is checked before asking.
- **Approval ledger**: single-use entries (`take`): a *round* entry per multi round-trip ask and an *approved* entry
  per (actor, hash) for out-of-band approvals; `kv`-backed in remote modes, in-memory in stdio.
- **Refusals** (all errors): `AB_WRITE_APPROVAL_UNAVAILABLE`, `AB_WRITE_APPROVAL_DECLINED`, `AB_WRITE_CONFLICT`,
  `AB_WRITE_APPROVAL_PENDING` (the page's, P7-02) and the new `AB_WRITE_AUDIT_UNAVAILABLE` (intent could not be recorded).
- **Audit**: a sink port with `intent` (must succeed before sending) and `outcome`; HTTP writes `kind: 'write'` rows
  through `AuditWriter.writeIntent`, stdio logs both to stderr (weaker, documented). Rows carry field names and the hash,
  never values.
- `whoami` and dry runs report the approval channel available to this request; `AB_WRITE_APPROVAL=off` only in stdio.
- `tools/list` budget test with the write group enabled (a test tool in the `writes` group).

## Acceptance criteria
- [x] Tests: every layer missing → tool absent; shared credential → never writes; approval replay refused; approval for a different target or value refused; intent-audit failure → refused; refusals are errors.
- [x] Approval text shows the full change; oversized approvals refused rather than truncated.
- [x] A test-only write tool runs the whole pipeline on fakes: dry run, no confirm, declined, unavailable, conflict, no-op, applied once, outcome audited, no retry after a failed send.
- [x] Both elicitation eras are tested: 2026-07-28 `input_required` (first round, approved and declined retries, forged and replayed state) and 2025-era push elicitation; a client without the capability gets `AB_WRITE_APPROVAL_UNAVAILABLE` as a tool error.
- [x] The registry refuses a non-read tool that was not built by `defineWriteTool`, or that is outside the `writes` group.
- [x] HTTP host: write tools reach `tools/list` only for `access.writeTools`; the runtime uses the `kv` ledger and `kind: 'write'` audit rows (tested with a fake tool).
- [x] stdio host: `AB_WRITE_TOOLS` and `AB_WRITE_APPROVAL=off` parsed, startup warning when approval is off.
- [x] `tools/list` budget test with the write group enabled.
- [x] `docs/guide/write-tools.md` and THREAT_MODEL updated; decisions in `docs/pending-decisions/phase-7.md`.
- [ ] *Sandbox (P7-07):* the pipeline against a real writable instance (real re-read values, read lag, one real approval in a client). Staging Workers: P7-10; real clients rendering the approval text: P7-12; audit viewer: P7-11.

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
- docs/pending-decisions/phase-7.md (D-155 to D-162), LESSONS-LEARNED (L-383 to L-386)

## Out of scope
- Anything not listed under Scope.
