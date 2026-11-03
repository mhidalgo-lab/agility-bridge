---
id: P9-10
title: Admin API pre-review follow-ups (instance read scope, re-enable policy, A5 wording)
phase: 9
status: todo
priority: low
depends_on: [P9-02]
adr: []
lessons: [L-065, L-121]
owner: ""
---

# P9-10 — Admin API pre-review follow-ups

## Goal
Close three low-severity points the internal pre-review (P9-02) found in the admin API, each of which needs a small design
choice before code.

## Scope
- **Members read every instance.** `GET /instances` and `GET /instances/{id}` answer a member with every instance, including
  `tls.caFile` (a path on the server's disk), `baseUrl` and `metaFingerprint`, for instances the member has no grant on.
  Return only the instances of the member's own live grants and omit `tls` for non-managers (update the panel screens and
  `admin.test.ts`, which asserts today's behaviour).
- **Re-enabling an instance** an owner switched off is possible for an admin (`PATCH /instances/{id}` with `disabledAt: null`).
  Today's design (and `admin.test.ts` "adds, renames, disables, enables and deletes an instance as an admin") allows it;
  decision D-350 recommends keeping it and documenting it. If the owner decides otherwise: owner plus recent sign-in for
  re-enabling, with a regression test.
- **A5 wording.** `grants.create` has no personal-credential owner check (create must allow an owner to give a write grant on a
  user's credential; the storage trigger already forces the credential owner to equal the grant's user). Make the threat
  model row and the access guide say exactly this, and pin it with a test.

## Acceptance criteria
- [ ] A member never receives an instance without a live grant of their own, nor its `tls` object; tests for list, get and
      the panel; the change is in the threat model (A14).
- [ ] D-350 is answered and the chosen behaviour is documented and tested.
- [ ] A5's wording matches the code and a test pins it.

## Security notes
T14, A5, A14.

## Lessons applied
- L-065 — Every alternate writer is an authorization boundary.
- L-121 — Negative authorization tests that fail when the fix is reverted.

## Docs to update
- docs/THREAT_MODEL.md, docs/guide/access-model.md, docs/guide/admin-access.md

## Out of scope
- Anything outside the admin API.
