---
id: P7-05
title: "Writes wave 2: create work items and update fields"
phase: 7
status: todo
priority: medium
depends_on: [P7-04]
adr: ["0011", "0013"]
lessons: [L-044, L-108, L-142]
owner: ""
---

# P7-05 — Writes wave 2: create work items and update fields

> Scope refined 2026-10-29 (tasks/README rule 7): built and tested on fakes that model the documented request shapes; every
> write shape never verified against a real instance is marked *unverified* in RESEARCH §1.5 and goes to the sandbox run
> (P7-07). Choices the task left open are D-179..D-184 in `docs/pending-decisions/phase-7.md`.

## Goal
Create backlog items, defects, tasks, tests and epics, and update a small allowlist of fields, each built with
`defineWriteTool` and nothing else (ADR-0013: typed fields, one target, no generic mutation, no `where`, no delete).

## Scope
- `create_work_item` (`item_type`, `name`, `project`, `parent`, `description`, `estimate`, `priority`): one new item in one
  Agility project of the workspace. A task or test needs a parent story or defect and lives in the parent's project; a story,
  defect or epic needs a project and may have an epic as parent. The one **target** of the mutation is the project; the
  approval shows every field of the new item (old: empty). The re-read is a validity check (project and parent still visible,
  open and in scope; the item not created meanwhile), not a value comparison. Idempotency is derived, not keyed (D-179).
- `update_fields` (`asset`, `name`, `description`, `estimate`, `priority`): changes only allowlisted attributes of one open
  item, old -> new for each, only differing fields sent. The allowlist is typed per asset type: Story and Defect take Name,
  Description, Estimate, Priority; Task and Test take Name, Description, DetailEstimate; Epic takes Name, Description.
- Never reachable by either tool: custom attributes (D-181), the project (`Scope`) of an existing item, status, owners,
  sprint, team, parent re-parenting, deletion and any other attribute; no tool argument can name an attribute.
- Defaults come from the instance when Agility applies them on create (`rest-1.v1/New` is not called, D-180); required-field
  rules are Agility's and a refused create creates nothing.
- Descriptions are plain text on the way in and escaped HTML paragraphs on the way out (D-182).
- Catalogue: both tools join the `writes` group; reference regenerated; worst-case cost fixtures; `tools/list` budgets
  (every group under 72 KB, fewer than 40 tools with every group on).

## Acceptance criteria
- [x] For each tool, on fakes: dry run, approval, conflict on re-read, repeat/no-op, refusal paths and the exact request body
  asserted in full.
- [x] Round-trip tests read every created or updated asset back through the read tools (`get_work_item`).
- [x] Negative authorization: absent unless enabled at every layer; a denied asset type, a project, parent or item outside the
  workspace, a closed or non-open project, a custom or non-allowlisted field and a field the type does not have are refused with
  no write and no approval.
- [x] A repeated approved create does not create twice (derived idempotency, D-179), also when the repeat arrives while the first
  approval is pending.
- [x] Untrusted text (names, description, priority and parent names) appears only inside the envelope; hidden characters are
  refused; markup in a description is escaped.
- [x] Worst-case cost fixtures, `tools/list` budgets and lints pass with no exceptions.
- [x] Docs: tool reference, write guide, RESEARCH (unverified shapes), THREAT_MODEL, decisions, P7-07 checklist.
- [ ] *Sandbox (P7-07):* create and update against a real writable instance (listed in P7-07).

## Security notes
THREAT_MODEL A2, A1 (no content from tool results copied into writes without approval), T3 (the project restriction), T4.

## Lessons applied
- L-044 — Round-trip what you create.
- L-108 — Validate fully, then ask, then re-check, then apply once.
- L-142 — Status, AssetState and rollup category are different things (the tool never touches them).

## Docs to update
- docs/reference/tools.md (generated)
- docs/guide/write-tools.md
- docs/RESEARCH.md §1.5, docs/THREAT_MODEL.md, docs/pending-decisions/phase-7.md

## Out of scope
- Custom attributes, owners, team, sprint, status and `Scope` changes on create or update (P7-20, P7-21); attachments; links.
- Anything not listed under Scope.
