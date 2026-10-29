---
id: P7-04
title: "Writes wave 1: comment, status, effort, owners, sprint"
phase: 7
status: review
priority: high
depends_on: [P7-01, P7-03]
adr: ["0011", "0013"]
lessons: [L-051, L-108, L-142]
owner: "claude"
---

# P7-04 — Writes wave 1: comment, status, effort, owners, sprint

> Scope refined 2026-10-29 (tasks/README rule 7): built and tested on fakes that model the documented request shapes;
> every write shape that was never verified against a real instance is marked *unverified* in RESEARCH §1.5 and goes
> to the sandbox run (P7-07).

## Goal
The everyday changes: `add_comment`, `update_status`, `log_effort`, `assign_owners`, `move_to_sprint`, each built with
`defineWriteTool` and nothing else.

## Scope
- **Transport** (D-172): `POST rest-1.v1/Data/<Type>[/<id>]` with an XML asset document (`act="set"|"add"|"remove"`), the
  shapes RESEARCH §1.5 documents, through the existing `restWrite` (sent once, never retried). The XML is built by one
  builder that validates names and OIDs and escapes every value; nothing is concatenated from caller text.
- **Common plan**: one work item resolved through `resolveAsset` (scope rechecked, denied types refused), a second read of
  its current values (the re-read uses the same read), refusal of deleted and closed targets (comments excepted on closed
  items), the attribute must exist and be writable on the type in the instance metadata.
- `add_comment`: text 1 to 4,000 characters, line breaks normalised, control and invisible characters refused, shown in
  full in the approval; creates an `Expression` that mentions the item; an identical latest comment by the same member is
  an idempotent no-op.
- `update_status`: the status resolved from the instance's list for the item's type and its team's workflow (L-142); sets
  `Status` only (never closes). `log_effort`: hours (0.01 to 24), date, for the caller; creates an `Actual`; an identical
  entry (item, member, date, hours) is a no-op. `assign_owners`: `add` and `remove` lists of members resolved through the
  member resolver, applied as `add`/`remove` on `Owners`. `move_to_sprint`: a sprint of the item's project schedule that is
  not closed.
- Values in the mutation carry both the readable name and the OID (`Name [Member:20]`) so the approval is readable and the
  hash binds the OID (D-173).
- Catalogue: the tools join `CORE_TOOLS` (group `writes`, kind `write`), tool reference and catalogue regenerated, the
  worst-case cost test and the `tools/list` budgets cover them (33 tools in all, every group on).

## Acceptance criteria
- [x] For each tool, on fakes: dry run, approval, conflict on re-read, no-op repeat, refusal paths, and the exact request
  body sent (asserted in full).
- [x] Negative authorization tests: tool absent unless enabled at every layer; a denied asset type and an out-of-scope
  target are refused with no write and no approval.
- [x] Untrusted Agility text (names, statuses) and the comment text appear only inside the envelope in approvals and results;
  `add_comment` refuses control characters and shows the full text.
- [x] Worst-case cost fixtures; `tools/list` budgets hold; lints pass with no exceptions.
- [x] Docs: tool reference, guide, RESEARCH (unverified shapes), THREAT_MODEL, decisions D-172..D-178.
- [ ] *Sandbox (P7-07):* each write against a real writable instance, read-lag and response shapes (listed in P7-07).

## Security notes
THREAT_MODEL A2.

## Lessons applied
- L-051 — Expect read-after-write lag.
- L-108 — Validate fully, then ask, then re-check, then apply once.
- L-142 — Status, AssetState and rollup category are different things.

## Docs to update
- docs/reference/tools.md (generated)

## Out of scope
- Anything not listed under Scope.
