---
id: P8-31
title: "Bind a keychain token to the instance it was stored for"
phase: 8
status: review
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

Built: sibling entry `<account>#host` (D-306), refusal with `keychain bind` as the confirmation (D-307), warn-then-refuse
migration (D-308), commands, `status`, `doctor` and `client-config` (D-309). Covers the stdio environment path.

## Acceptance criteria
- [x] A token stored for host A is not sent to host B without an explicit confirmation step.
- [x] A test proves the refusal and that the stored-for host still works.
- [x] Works on the macOS, Linux and Windows backends with no secret on argv (fakes on every OS; the sibling entry uses only get, set and delete).
- [x] `doctor` reports bound, unbound and mismatched; docs and THREAT_MODEL T8/T23 updated.
- [ ] A real macOS, Linux and Windows run of `keychain set --for-url`, `keychain bind` and a mismatch (owner; unverified on real keychains).

## Security notes
THREAT_MODEL T8 and T23: closes the remaining half of S-2.

## Lessons applied
- none

## Docs to update
- docs/guide/secrets.md

## Out of scope
- Anything outside the item above.
