---
id: P2-16
title: Self-hosting docs and executable-docs check
phase: 2
status: review
priority: medium
depends_on: [P2-11]
adr: []
lessons: [L-083, L-133]
owner: "Matias Hidalgo"
---

# P2-16 — Self-hosting docs and executable-docs check

## Goal
An operator can run agility-bridge on a server or in Docker, behind a proxy, next to an on-premises instance.

## Scope
- `docs/guide/self-hosting.md`: Node and Docker, reverse proxy, `AB_PUBLIC_URL` and HSTS, Host/Origin, backups and the master key, custom CA bundles for on-premises instances, upgrades.
- `docs/guide/multi-device.md`: one token per device, revocation.
- Executable check of every documented command against the built image.

## Acceptance criteria
- [x] A fresh-VM walkthrough succeeds and is recorded in the verification notes. *(A fresh container rather than a VM:
  `scripts/walkthrough.ts` executes the marked blocks of the self-hosting and CLI guides from the packed package; it
  passed on 2026-10-21 and runs in the CI Docker job; docs/dev/verification.md records it and what a container does not
  cover.)*

## Notes
- `docs/guide/self-hosting.md` (rewritten): Node install, serve, systemd, reverse proxy (Caddy, nginx), `AB_PUBLIC_URL`
  and HSTS, Host/Origin, proxy hops, on-premises CA (`instance add --ca-file`), Docker and Compose, backups and the
  master key, restore, upgrades. `docs/guide/multi-device.md` (new).
- New CLI commands the guide needed: `backup <file>` (consistent, `0600`, never overwriting) and
  `restore <backup> <target>` (checked, never overwriting); file and migration errors exit 1 with a message.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-083 — Derive security headers from the public URL.
- L-133 — Execute the documentation.

## Docs to update
- [x] docs/guide/self-hosting.md
- [x] docs/guide/multi-device.md

## Out of scope
- Anything not listed under Scope.
