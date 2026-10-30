---
id: P8-42
title: "Bind keychain tokens named in the YAML configuration"
phase: 8
status: todo
priority: low
depends_on: [P8-31]
adr: []
lessons: []
owner: ""
---

# P8-42 — Bind keychain tokens named in the YAML configuration

## Goal
A `${keychain:...}` inside the user's own YAML file is not host-checked (D-309). Check it against the workspace's instance url, or document why it is safe.

## Scope
A `${keychain:...}` token of `workspaces.<id>.instance.token` is checked against that instance's host like the environment path.

## Acceptance criteria
- [ ] A `${keychain:...}` token of `workspaces.<id>.instance.token` is checked against that instance's host like the environment path.
- [ ] The user's own file may still name any service; the binding applies to it too.
- [ ] A test proves it, including a negative case.

## Security notes
THREAT_MODEL T8 and T23 (follow-up of P8-31, D-308 and D-309).

## Lessons applied
- none

## Docs to update
- docs/guide/secrets.md

## Out of scope
- Anything outside the item above.
