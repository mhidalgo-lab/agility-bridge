---
id: P8-31
title: "Bind a keychain token to the instance it was stored for"
phase: 8
status: todo
priority: low
depends_on: []
adr: []
lessons: []
owner: ""
---

# P8-31 — Bind a keychain token to the instance it was stored for

## Goal
A project-scoped client file can set `AB_AGILITY_URL` to another host while `AB_AGILITY_TOKEN=keychain:agility-token` names the user's own entry, and the server then sends the real token there (Phase 8 review S-2; D-290 only protects other applications' entries).

## Scope
- Store the canonical instance host with the keychain entry (or in a sibling entry) when the token is stored for an instance.
- Refuse, or warn in `doctor` and on stderr, when the resolved token is used with a different host.
- Decide the migration for entries stored without a host.

## Acceptance criteria
- [ ] A token stored for host A is not sent to host B without an explicit confirmation step.
- [ ] A test proves the refusal and that the stored-for host still works.

## Security notes
THREAT_MODEL T8 and T23: closes the remaining half of S-2.

## Lessons applied
- none

## Docs to update
- docs/guide/secrets.md

## Out of scope
- Anything outside the item above.
