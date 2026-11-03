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

> Scope and acceptance criteria refined 2026-11-03 (tasks/README rule 7). P8-12 is waived as a dependency by the owner
> (live pass pending). The backport machinery itself (`plan` accepts `release/x.y`, npm dist-tag `release-x.y`, no
> `latest`) shipped in P8-68; this task verifies it end to end, closes the gaps and documents it.

## Goal
Anyone can verify a release, and security fixes can ship to older minors.

## Scope
- Verification guide for npm provenance, checksums, SBOM and signed images: every command run against the latest
  published release and fixed where it did not work (L-133).
- `release/x.y` backport branches with the same guards as `main`: changesets, a tag never moving backwards, provenance,
  release egress restrictions; what a backport branch has to carry from `main`.
- A backport dry run that publishes nothing and pushes no `release/*` branch or tag.
- The exact GitHub settings for the `release/*` branches and the `v*` tags, written down for the owner.

## Acceptance criteria
- [ ] `docs/guide/verify-release.md` was executed command by command against the latest published release (0.8.0) and
      every command works; non-obvious behaviour (silent success, exit codes) is documented.
- [ ] `docs/dev/releasing.md` documents the `release/x.y` path: when and how to cut it, the guards (`plan`, `publish`,
      `image`), the dist-tag and image-tag rules, the egress policy, and a repeatable dry run.
- [ ] A release never publishes a version lower than one already on npm in the same `x.y` line (tested).
- [ ] A backport dry run was executed locally (plan, version, build, package check, image tags) and its result is
      recorded; nothing was pushed or published.
- [ ] `docs/security/repo-settings.md` lists the exact `release/*` and `v*` settings; THREAT_MODEL T18 is updated.
- [ ] *owner:* create or confirm the settings above on GitHub (the `v*` tag ruleset was not found on 2026-11-03).
- [ ] *owner:* the verification guide executed by someone other than the author.

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
