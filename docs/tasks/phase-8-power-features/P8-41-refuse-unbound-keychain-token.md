---
id: P8-41
title: "Refuse an unbound keychain token"
phase: 8
status: review
priority: low
depends_on: [P8-31]
adr: []
lessons: []
owner: ""
---

# P8-41 — Refuse an unbound keychain token

## Goal
Entries stored without a host still work with a warning (D-308). After a release with the warning, refuse them so the redirect hole is closed for everyone.

## Scope
`AB_AGILITY_TOKEN=keychain:<name>` with no stored host stops startup and names `keychain bind`.

## Acceptance criteria
- [x] `AB_AGILITY_TOKEN=keychain:<name>` with no stored host stops startup and names `keychain bind`.
- [x] `doctor` reports it as a failure.
- [x] A test proves it, including a negative case.
- [ ] Merged after v0.8.0 is released (D-308, D-320): the refusal must not reach a release before the one that first warns.

## Security notes
THREAT_MODEL T8 and T23 (follow-up of P8-31, D-308 and D-309).

## Lessons applied
- none

## Docs to update
- docs/guide/secrets.md

## Out of scope
- Anything outside the item above.
