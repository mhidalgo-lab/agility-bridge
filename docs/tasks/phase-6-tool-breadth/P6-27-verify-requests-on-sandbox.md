---
id: P6-27
title: Verify requests and empty asset types on a writable sandbox
phase: 6
status: todo
priority: low
depends_on: [P6-06]
adr: ["0012"]
lessons: [L-298, L-299]
owner: ""
---

# P6-27 — Verify requests and empty asset types on a writable sandbox

## Goal
Check against a real Agility instance what P6-06 could only check on fixtures: the read-only tenant holds no requests, so
the `Request` recipe, its default tier and the `RequestStatus` list were exercised offline only (the type itself answered
with an empty page).

## Scope
- On the writable sandbox (owner checklist, before Phase 7): create a few synthetic requests in two statuses and read them
  with `query_assets` (recipe examples), `get_assets` and `describe_asset_type` (status list).
- Compare the product attributes of `Request`, `RequestStatus` and `Retrospective` with the snapshot (`pnpm metadata:drift`
  against the sandbox) and record corrections.
- Add the request level to the live other-assets suite as "present".

## Acceptance criteria
- [ ] Every example in the request recipe returns rows on the sandbox; the status list is non-empty in `describe_asset_type`.
- [ ] Drift against the sandbox is clean for the five types, or the snapshot is corrected with the reason in RESEARCH.
- [ ] `docs/dev/verification.md` records the request level as present.

## Security notes
Sandbox content is synthetic; nothing from the read-only tenant is used.

## Lessons applied
- L-298 — An absent type is a recorded gap, not a pass.
- L-299 — A hand-written snapshot entry is a guess until the drift check has read it.

## Docs to update
- docs/dev/verification.md, docs/RESEARCH.md

## Out of scope
- Writing requests through the bridge (Phase 7).
