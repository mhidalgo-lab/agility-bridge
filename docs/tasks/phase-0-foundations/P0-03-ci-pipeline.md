---
id: P0-03
title: CI pipeline
phase: 0
status: todo
priority: high
depends_on: [P0-01]
adr: ["0003", "0004"]
lessons: [L-129, L-130, L-104, L-123]
owner: ""
---

# P0-03 — CI pipeline

## Goal
Every PR runs the same checks as local development, on GitHub-hosted runners, with least privilege.

## Scope
- `ci.yml` on push to `main` and pull requests: frozen install, lint, typecheck, test, build.
- Node 24 matrix (plus the next LTS when released); OS matrix with Windows and macOS for CLI and SQLite paths.
- Workflow lint (actionlint), DCO check, Conventional PR title check.
- Hardening: actions pinned by full SHA, `permissions: contents: read` by default, harden-runner with egress audit (block once the allowlist is known), concurrency cancellation, no `pull_request_target`, no secrets for fork PRs.
- pnpm store caching; a time budget for the whole pipeline.

## Acceptance criteria
- [ ] CI is green on a sample PR in under 15 minutes.
- [ ] A test fails when a workflow uses an unpinned action or broad permissions.
- [ ] The Windows job runs a SQLite placeholder test.
- [ ] `docs/security/repo-settings.md` lists the required checks and branch rules.

## Security notes
THREAT_MODEL T18. GitHub-hosted runners only; never a fallback to self-hosted runners for public PRs (L-129).

## Lessons applied
- L-129 — GitHub-hosted runners only.
- L-130 — Pin and verify everything the pipeline runs.
- L-104 — Test SQLite on Windows too.
- L-123 — Make property tests meaningful and deterministic.

## Docs to update
- CONTRIBUTING.md (CI section)
- docs/security/repo-settings.md (new)

## Out of scope
- Release workflow (P1-15)
- CodeQL and gitleaks (P0-04)
