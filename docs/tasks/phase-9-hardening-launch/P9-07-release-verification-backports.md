---
id: P9-07
title: Release verification guide and backport path
phase: 9
status: todo
priority: medium
depends_on: [P8-12]
adr: []
lessons: [L-128, L-131]
owner: ""
---

# P9-07 — Release verification guide and backport path

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Anyone can verify a release, and security fixes can ship to older minors.

## Scope
- Verification guide for npm provenance, checksums, SBOM and signed images; `release/x.y` backport branches with the same guards; release egress restrictions.

## Acceptance criteria
- [ ] A backport dry run; verification guide executed by someone other than the author.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-128 — Releases are idempotent and tags never move backwards.
- L-131 — Guard the release path.

## Docs to update
- docs/guide/verify-release.md
- docs/dev/releasing.md

## Out of scope
- Anything not listed under Scope.
