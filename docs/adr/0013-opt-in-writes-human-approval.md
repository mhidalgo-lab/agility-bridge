# ADR-0013 — Opt-in write tools with human approval by default

- **Status:** accepted (owner, 2026-10-16) for the policy; the approval-channel details follow the owner's answers to
  D-10 – D-12 (2026-10-19) and are verified in Phase 7 (P7-07)
- **Date:** 2026-10-16
- **Related:** P7-01 – P7-09, L-025, L-051, L-105 – L-112, THREAT_MODEL T31, A2, A6

## Context

In a work-management tool, writes are where much of the value is: change a status, add a comment, log effort, assign
owners, move to a sprint, create a defect or task. They are also where prompt injection through user-generated content
(descriptions, comments) turns into real damage on shared work items.

## Decision

- **Read-only by default.** Write tools are absent from `tools/list` unless enabled at every layer: the server switch
  (`AB_WRITE_TOOLS=on`), the workspace's tool list and the grant's tool list (both naming the tool explicitly; "all tools"
  never includes writes), the OAuth `mcp:write` scope with its own non-remembered consent, and a personal credential
  (shared credentials never write). Only owners enable writes on a workspace or grant.
- **Typed operations only**: one tool per operation with an explicit field allowlist (`add_comment`, `update_status`,
  `log_effort`, `assign_owners`, `move_to_sprint`, `create_work_item`, `update_fields`, ...), each with a typed field
  allowlist per asset type. No generic mutation tool; no where-based or multi-asset mutation; no delete in 1.0. Closing and reopening are `destructive`.
- **Human approval required by default** (`AB_WRITE_APPROVAL=required`), showing the complete change (target, every
  field, old → new values), bound to a hash of the canonical arguments, actor, target and expiry, and single-use
  (replay ledger). Two approval channels:
  - **MCP elicitation** when the request can be elicited (stdio with an eliciting client; 2026-07-28 HTTP requests through
    multi round-trip requests);
  - an **out-of-band approval page** in the signed-in panel when it cannot (VS Code and Cursor speak only 2025-era
    revisions, which cannot be elicited over stateless HTTP; mobile apps): the tool returns `AB_WRITE_APPROVAL_PENDING`
    with a link, the user reviews and approves the exact change there, and the agent repeats the call (P7-02; details
    pending owner decision D-12 in [pending decisions](../pending-decisions/phase-0.md)).

  `confirm: true` is required too but is never approval. Without either channel the write is refused with
  `AB_WRITE_APPROVAL_UNAVAILABLE`; `whoami` and dry runs report which channel is available. Relaxing approval
  (`AB_WRITE_APPROVAL=off`, with a startup warning) is proposed for stdio mode only (single user, own token); shared
  deployments always require approval (D-10).
- **Approval state per runtime**: remote modes keep the single-use ledger in the storage `kv` table and write the intent
  audit durably; stdio keeps the ledger in process memory, protects multi round-trip request state with an HMAC under a
  per-process key, and logs intent and outcome to stderr (no audit table there; documented as weaker).
- **Dry run** (`dry_run: true`) validates everything and returns the exact plan without sending anything.
- **Apply once**: validate → approve → re-read the target and refuse if it changed (`AB_WRITE_CONFLICT`) → idempotent
  no-op if already applied → audit intent durably → send once, never retry → audit outcome. Results note that Agility
  may take a moment to show the change.
- **Limits**: per-grant write rate (default 20/hour), deployment-wide on Workers (shared limiter, fails closed).

## Consequences

- Writes ship late (Phase 7) and carry the heaviest test and documentation burden.
- Remote writes from clients that cannot elicit need the panel (Phase 4) and a signed-in user; in stdio mode they need an
  eliciting client or an operator who relaxes approval.

## Alternatives considered

- **Writes on by default within the token's permissions:** rejected by the owner.
- **Writes only after 1.0:** rejected; writes are core value for Agility users.
