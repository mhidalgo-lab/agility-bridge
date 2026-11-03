---
id: P9-09
title: Close the partly met ASVS rows
phase: 9
status: todo
priority: medium
depends_on: [P9-06]
adr: []
lessons: [L-010, L-483]
owner: ""
---

# P9-09 — Close the partly met ASVS rows

## Goal
Every ASVS 5.0 Level 2 row that [`asvs-l2.md`](../../security/asvs-l2.md) marks `Partly` is either met with a test or
documented as the operator's job, so the self-assessment has no soft spot before 1.0.

## Scope
- V7.5.2: let a person list their own active browser sessions (not only sign out everywhere), or document why the
  device list is the intended surface.
- V13.3.1, V13.3.2: document and, where cheap, test that the master key and tokens are readable only by the server
  process (file modes are tested; add the Worker secret and keychain paths to the secrets guide checklist).
- V13.4.4: a Node listener test that a raw `TRACE` and `CONNECT` get a fixed refusal (the fetch `Request` type cannot
  express them, so the test must use a socket).
- V15.3.7: a test that every endpoint that reads a query or form parameter treats a repeated parameter the same way.
- V16.4.1, V16.4.2: a test that a value with newlines or control characters cannot start a new log line, and a
  statement in the logging inventory of who may read and change audit rows (no update or delete path).

## Acceptance criteria
- [ ] Each listed row is `Met` (test linked) or `Delegated` (documented), and `asvs-l2.md` is updated;
      `scripts/test/asvs-l2.test.ts` passes.
- [ ] Negative tests fail when the fix is reverted (L-121).

## Security notes
V13.3, V13.4, V15.3, V16.4 of ASVS 5.0; threat-model rows T8, T24, T35.

## Lessons applied
- L-010 — Every security claim needs evidence.
- L-483 — Evidence maps are read by a test.

## Docs to update
- docs/security/asvs-l2.md, docs/security/logging.md, docs/guide/secrets.md

## Out of scope
- ASVS Level 3.
