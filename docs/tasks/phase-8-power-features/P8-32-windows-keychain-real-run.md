---
id: P8-32
title: "Verify the Windows keychain backend on a real machine"
phase: 8
status: todo
priority: low
depends_on: []
adr: []
lessons: []
owner: ""
---

# P8-32 — Verify the Windows keychain backend on a real machine

## Goal
The PowerShell Credential Manager script (P8-08) has only run against fakes (D-273). Q-9 pinned UTF-8 pipes and D-293 refuses non-ASCII secrets until a real run proves them.

## Scope
- On a Windows machine run `keychain set`, `status --name`, `delete` and a token resolved through `AB_AGILITY_TOKEN=keychain:...`, with `AB_TEST_KEYCHAIN=1`.
- Try a secret with non-ASCII characters; if it round trips, lift the refusal and add a test.
- Record the result with the date in docs/RESEARCH.md.

## Acceptance criteria
- [ ] The round trip works on Windows 10 or 11 with Windows PowerShell 5.1.
- [ ] The non-ASCII decision (D-293) is confirmed or reversed with evidence.

## Security notes
none beyond T8.

## Lessons applied
- none

## Docs to update
- docs/guide/secrets.md

## Out of scope
- Anything outside the item above.
