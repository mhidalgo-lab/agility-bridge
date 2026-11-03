---
id: P9-23
title: Backport ancestry guard and a dispatch dry-run mode
phase: 9
status: todo
priority: low
depends_on: [P9-07]
adr: []
lessons: [L-128, L-131, L-499]
owner: ""
---

# P9-23 — Backport ancestry guard and a dispatch dry-run mode

## Goal
A `release/x.y` branch can only release commits that descend from the line's release tag, and the whole release
workflow can be rehearsed on a pushed branch without staging or pushing anything.

## Scope
- `plan` checks (GitHub compare API, since the checkout is shallow) that `GITHUB_SHA` is ahead of or identical to the
  tag `vX.Y.0` of the branch's line; otherwise it fails. Unit tests for the decision.
- A `workflow_dispatch` input `dry_run` (default `true` on `release/*`): `plan`, `build` and `image-build` run, `publish`
  and `image` stop before any `npm stage publish`, `gh release create` or registry push, and print what they would do.
  The `release.test.ts` guards prove no write step runs in dry-run mode.

## Acceptance criteria
- [ ] A branch `release/0.8` containing an unrelated commit fails `plan` (test).
- [ ] A dry-run dispatch publishes nothing: no staged package, no release, no registry tag (workflow tests).
- [ ] Docs: releasing.md updated; the local dry run stays as the offline option.

## Security notes
T18: the dry-run input must not widen who can publish; `publish` keeps the `release` environment approval.

## Lessons applied
- L-499 — a branch runs its own pipeline; guards must be carried forward.

## Docs to update
- docs/dev/releasing.md, docs/THREAT_MODEL.md (T18)

## Out of scope
- Creating `release/*` branches or rulesets (owner steps).
