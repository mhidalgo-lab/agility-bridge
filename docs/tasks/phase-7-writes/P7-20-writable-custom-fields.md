---
id: P7-20
title: "Workspace-enabled writable custom fields"
phase: 7
status: review
priority: low
depends_on: [P7-05]
adr: ["0013"]
lessons: [L-397, L-399]
owner: ""
---

# P7-20 — Workspace-enabled writable custom fields

> Filed by P7-05 ([writes wave 2](P7-05-writes-wave-2.md)). Refine scope and acceptance criteria before starting.

## Goal
Let an owner name the custom attributes an agent may write on create and update, per workspace (D-181 refused them in wave 2).

## Scope
Built now, on fakes; every request shape is *unverified* and on the P7-07 checklist.
- A per-workspace allowlist of custom attribute names: `writePolicy.customFields` (at most 20 names, each `Custom_` plus letters, digits and underscores), set by an owner with a recent sign-in through the admin API (`PATCH /workspaces/{id}`, which replaces `writePolicy` as a whole) and the workspace form ("Owner settings"); for stdio `AB_WRITE_CUSTOM_FIELDS` or `writes.custom_fields` in the configuration file. It reaches the tools as `ctx.workspace.writes.customFields`; a request that is not allowed to write has none.
- `create_work_item` and `update_fields` take one `custom` argument: a list of `{ attribute, value }` (at most five). The description of the argument is static and never names an instance attribute (THREAT_MODEL A12): the model learns attribute names from `describe_asset_type` (enveloped output). An attribute not in the workspace list is refused before any request and the refusal does not list the allowed names.
- Each attribute is checked against the instance metadata: it exists on the type, is custom, writable, single-valued and of kind `Text` (one line, at most 400 characters), `LongText` (plain text, at most 4,000 characters, sent as escaped paragraphs like a description; an old value with formatting is not replaced) or `Numeric` (a finite number). Other kinds (lists, dates, booleans, rich relations) are refused.
- The canonical mutation carries each as `Custom_X` old to new, so the approval shows it and the hash binds it; the write framework accepts a custom field only for a tool that opted in and only when the workspace list names it (re-checked by the framework, not only by the tool).
- The approval, the re-read and the no-op rules are the same as for the other fields.
- Not in scope: the CLI `workspace set` has no option for write settings today (the admin API and panel do); not added here.

## Acceptance criteria
- [x] Each addition has dry run, approval, conflict, no-op and refusal tests, negative authorization tests and the request body asserted.
- [ ] *Sandbox (P7-07):* each against a writable instance.

## Security notes
THREAT_MODEL A2, A12, T4, T31.

## Lessons applied
- L-108 — Validate fully, then ask, then re-check, then apply once.
- L-397 — A create's one target is the container.

## Docs to update
- docs/reference/tools.md (generated)
- docs/guide/write-tools.md

## Out of scope
- Anything not listed under Scope.
