---
id: P2-16
title: Self-hosting docs and executable-docs check
phase: 2
status: todo
priority: medium
depends_on: [P2-11]
adr: []
lessons: [L-083, L-133]
owner: ""
---

# P2-16 — Self-hosting docs and executable-docs check

## Goal
An operator can run agility-bridge on a server or in Docker, behind a proxy, next to an on-premises instance.

## Scope
- `docs/guide/self-hosting.md`: Node and Docker, reverse proxy, `AB_PUBLIC_URL` and HSTS, Host/Origin, backups and the master key, custom CA bundles for on-premises instances, upgrades.
- `docs/guide/multi-device.md`: one token per device, revocation.
- Executable check of every documented command against the built image.

## Acceptance criteria
- [ ] A fresh-VM walkthrough succeeds and is recorded in the verification notes.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-083 — Derive security headers from the public URL.
- L-133 — Execute the documentation.

## Docs to update
- docs/guide/self-hosting.md
- docs/guide/multi-device.md

## Out of scope
- Anything not listed under Scope.
