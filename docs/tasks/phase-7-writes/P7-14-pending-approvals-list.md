---
id: P7-14
title: A list of my pending approvals
phase: 7
status: done
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
Refined 2026-10-29.

- `GET /admin/approve` (member role, panel session) lists the signed-in person's open requests: requested time, tool and operation, item (type and number), workspace, field **names**, change id, expiry, and a link to `/admin/approve/<id>`. It never shows a value or the item's title, and it never lists another person's request: the read is the key range of the signed-in person's own id.
- `ApprovalsPort.list` (admin-ui) implemented over `kv` in the approval page: one `list` and at most `MAX_PENDING_PER_USER` reads, expired and unreadable records skipped.
- A link "Changes waiting for my approval" on My access, shown only when the approval page exists (D-223: no count on the overview). The bound of 20 stays (D-224).
- Only on servers with `AB_WRITE_TOOLS=on` and sign-in; otherwise the route does not exist (404), like `/admin/approve/:id`.

## Acceptance criteria
- [x] The list shows only the signed-in person's requests (negative test: another user's request is absent, and a signed-out visitor goes to sign-in).
- [x] The list holds no value, title or script text from a request; an answered or expired request is not listed.
- [x] Panel tests, a browser (Playwright) check at both widths with the accessibility scan, and the guide updated.

## Security notes
THREAT_MODEL A13.

## Lessons applied
- L-106 — Approval shows and binds the complete change.

## Docs to update
- docs/guide/write-tools.md, docs/THREAT_MODEL.md

## Out of scope
- Anything not listed under Scope.
