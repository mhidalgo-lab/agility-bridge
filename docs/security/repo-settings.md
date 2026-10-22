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
| Required status checks | see below; **branch must be up to date with `main` before merging** (since 2026-10-22) | see below; up-to-date not required |

Raise the required approvals to 1 and add CODEOWNERS when a second maintainer joins (D-24, before 1.0 at the latest).

### Required status checks

From `.github/workflows/ci.yml` (P0-03):

- `Lint, typecheck, test, build (Node 24)`
- `Lint, typecheck, test, build (Node 26)`
- `Workflow lint`
- `DCO sign-off`
- `Conventional PR title`

From `.github/workflows/security.yml` (P0-04):

- `CodeQL`
- `Secret scan (gitleaks)`
- `Dependency audit`
- `Dependency review`

From `.github/workflows/ci.yml` (P2-11, required since 2026-10-22, D-25):

- `Docker image (build, smoke test, scan)`

To be added when its job exists: `Authorization suite` (P2-12). The macOS and Windows jobs (`SQLite and CLI (…)`) run on every PR but are not
required, as in relic-bridge.

## Code security

- Dependabot alerts on; Dependabot security updates off (updates come through Renovate, P0-04).
- **CodeQL** through `.github/workflows/security.yml` (`security-extended`, JavaScript/TypeScript and Actions; PRs,
  `main`, weekly), not the "default setup", so the two do not conflict. **OpenSSF Scorecard** runs on `main`, weekly
  and on branch-protection changes, and publishes to scorecard.dev.
- **Secret scanning on, with push protection.**
- **Private vulnerability reporting on** (the channel `SECURITY.md` names, P0-02).

## Actions

- Default workflow token: **read** repository contents; Actions may create and approve pull requests (the Changesets
  version PR needs it, P1-15).
- Workflows from **all outside contributors** need approval before they run. CI runs on GitHub-hosted runners only, never
  self-hosted (L-129); `pull_request_target` is not used. `scripts/check-workflows.ts` (in `pnpm lint`) enforces SHA
  pins, read-only default permissions, harden-runner on Linux jobs and pinned checksums for downloaded tools.

## Apps

- **Renovate** GitHub App, installed for this repository only (owner action). It reads `renovate.json`: weekly,
  grouped, releases at least 3 days old, majors behind dependency-dashboard approval, actions pinned by digest, CI tool
  binaries pinned by tag and sha256.

## Owner checklist (P0-04)

- [x] Rulesets, required checks from CI, secret scanning and push protection, private vulnerability reporting,
      Dependabot alerts, Actions policy and environments (applied 2026-10-19/20, above).
- [x] Install the Renovate GitHub App for this repository (2026-10-21; Dependency Dashboard is issue #14, the onboarding
      PR #13 closed itself because `renovate.json` was already present).
- [x] Add the four P0-04 checks to both rulesets once they have run on `main` (2026-10-21, above).
- [x] After the first Scorecard run on `main`, confirm the results appear on scorecard.dev and in code scanning
      (2026-10-21: score 6.6 for commit `90f85fc`; CodeQL and Scorecard analyses in code scanning).

Scorecard baseline (2026-10-21, 6.6/10). Expected low checks: `Code-Review` 0 (single maintainer, 0 approvals, D-24),
`Maintained` 0 (repository younger than 90 days), `CII-Best-Practices` 0 (P9-06), `Fuzzing` 0, `Packaging` and
`Signed-Releases` not applicable until P1-15, `Branch-Protection` 3 (no required approvals or CODEOWNERS yet, D-24).
Renovate reports `amannn/action-semantic-pull-request` (the Conventional PR title check) as possibly abandoned: last
release 2025-08-22; it still works and is pinned by SHA.

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
