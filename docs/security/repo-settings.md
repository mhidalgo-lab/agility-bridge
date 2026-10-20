# Repository settings

> Settings that can't be committed as files (P0-03). They mirror `mhidalgo-lab/relic-bridge` and were applied on
> 2026-10-19/20. Re-check them at every phase review and before each release; change this page in the same PR as any
> setting.

## General

- Default branch `main`. **Squash merge only** (merge commits and rebase merges off); the squash commit takes the PR
  title (a Conventional Commit, checked by CI) and the commit messages.
- Head branches are deleted automatically after merge. Auto-merge and "update branch" are off. Wiki off.

## Rulesets

Both rulesets are **active with no bypass actors**: nobody, including admins, can push to the protected branches
directly.

| Rule | `Protect main` (`~DEFAULT_BRANCH`) | `Protect release/*` (`refs/heads/release/*`) |
|---|---|---|
| Deletion | blocked | blocked |
| Force push (`non_fast_forward`) | blocked | blocked |
| Pull request | required; squash only; **0 approvals** (single maintainer, D-24); stale reviews dismissed; review threads must be resolved | same |
| Required status checks | see below | same |

Raise the required approvals to 1 and add CODEOWNERS when a second maintainer joins (D-24, before 1.0 at the latest).

### Required status checks

From `.github/workflows/ci.yml` (P0-03):

- `Lint, typecheck, test, build (Node 24)`
- `Lint, typecheck, test, build (Node 26)`
- `Workflow lint`
- `DCO sign-off`
- `Conventional PR title`

To be added when their jobs exist: `CodeQL`, `Secret scan (gitleaks)`, `Dependency audit`, `Dependency review` (P0-04)
and `Authorization suite` (P2-12). The macOS and Windows jobs (`SQLite and CLI (…)`) run on every PR but are not
required, as in relic-bridge.

## Code security

- Dependabot alerts on; Dependabot security updates off (updates come through Renovate, P0-04).
- **Secret scanning on, with push protection.**
- **Private vulnerability reporting on** (the channel `SECURITY.md` names, P0-02).

## Actions

- Default workflow token: **read** repository contents; Actions may create and approve pull requests (the Changesets
  version PR needs it, P1-15).
- Workflows from **all outside contributors** need approval before they run. CI runs on GitHub-hosted runners only, never
  self-hosted (L-129); `pull_request_target` is not used. `scripts/check-workflows.ts` (in `pnpm lint`) enforces SHA
  pins, read-only default permissions, harden-runner on Linux jobs and pinned checksums for downloaded tools.

## Environments

Secrets live only in environments, never at repository level.

| Environment | Reviewers | Deployment branches and tags | Used by |
|---|---|---|---|
| `live` | owner | `main` | live suite against the read-only tenant (P0-12, D-01); `AB_LIVE_*` secrets pending |
| `release` | owner | `main`, `release/*`, tags `v*` | npm trusted publishing (P1-15) |
| `staging` | — | `main` | Workers staging (Phase 3) |
| `github-pages` | — | `main` | documentation site (D-02, P9-04) |

## npm

- Package `agility-bridge` owned by the maintainer's npm account; `0.0.0` is a name placeholder (D-02, 2026-10-19).
- 2FA on. Trusted publishing from the `release` environment and staged publishing arrive with P1-15; no long-lived
  npm tokens.

