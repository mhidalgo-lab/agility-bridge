---
id: P7-14
title: A list of my pending approvals
phase: 7
status: todo
priority: low
depends_on: [P7-02]
adr: ["0013"]
lessons: [L-106]
owner: ""
---

# P7-14 — A list of my pending approvals

> Filed by P7-02 ([approval page](P7-02-approval-page.md)). Refine scope and acceptance criteria before starting.

## Goal
A person who lost the link (a chat that scrolled away, a phone) can find their open approval requests in the panel.

## Scope
- `GET /admin/approve` lists the signed-in person's open requests (tool, target, age, expiry) and links to each page; it never shows values.
- Decide whether the list needs a count on the overview page and whether 20 open requests per person (`MAX_PENDING_PER_USER`) is the right bound once real tools exist.

## Acceptance criteria
- [ ] The list shows only the signed-in person's requests (negative test: another user's request is absent).
- [ ] Panel tests, accessibility check and the reference for the page updated.

## Security notes
THREAT_MODEL A13.

## Lessons applied
- L-106 — Approval shows and binds the complete change.

## Docs to update
- docs/guide/write-tools.md

## Out of scope
- Anything not listed under Scope.
