---
id: P1-15
title: Release pipeline and v0.1.0
phase: 1
status: todo
priority: high
depends_on: [P1-09, P1-10, P1-11, P1-12, P1-13, P1-14]
adr: ["0003"]
lessons: [L-127, L-128, L-131, L-135]
owner: ""
---

# P1-15 — Release pipeline and v0.1.0

## Goal
Ship verifiable releases from day one, with build and publish separated.

## Scope
- Changesets version PR.
- Build job without OIDC: tarball (including `NOTICE` and `README.md`), CycloneDX SBOM, checksums, release notes.
- Publish job in the protected `release` environment: OIDC only here, no project code executed, checksum and tag verification, npm trusted publishing with provenance, staged publish approved with 2FA.
- GitHub Release with assets and attestations; idempotent reruns; `server.json` for the MCP Registry.
- README status and docs reconciled in the release PR.

## Acceptance criteria
- [ ] A dry-run release succeeds end to end.
- [ ] v0.1.0 published if the owner chose per-phase releases (pending decision D-03).
- [ ] `docs/guide/verify-release.md` explains how to verify provenance and checksums.

## Security notes
THREAT_MODEL T18.

## Lessons applied
- L-127 — Separate building from publishing.
- L-128 — Releases are idempotent and tags never move backwards.
- L-131 — Guard the release path.
- L-135 — README and docs are release artifacts.

## Docs to update
- docs/dev/releasing.md (new)
- docs/guide/verify-release.md (new)
- README.md

## Out of scope
- Anything not listed under Scope.
