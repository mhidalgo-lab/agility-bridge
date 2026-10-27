# Releasing

Releases follow ADR-0003 and THREAT_MODEL T18: build and publish are separate jobs, only the publish and image jobs can
mint an OIDC token and they run no project code, and a version goes live only after **two** approvals (the GitHub `release`
environment, then 2FA on npmjs.com). The pipeline is adapted from relic-bridge's, which has shipped thirteen releases
with it.

## Flow

1. Pull requests that change the published package (`apps/cli` or a workspace package bundled into it) add a changeset
   naming `agility-bridge` (`pnpm changeset`).
2. On `main`, `release.yml` `plan` sees pending changesets and the `version` job opens or updates the **Version
   Packages** PR (`pnpm version-packages`: `changeset version`, then `release.ts sync-version`, which writes `VERSION`
   in `packages/core/src/version.ts` and the versions in `server.json`). PRs opened with the workflow token do not
   trigger CI: close and reopen it to run the checks, then merge it.
3. The merge leaves no changesets and a version npm does not have (mode `publish`). With `AB_RELEASE_ENABLED=true`,
   `build` installs, lints, typechecks, tests, builds, packs and checks the tarball (`scripts/check-package.ts`), and
   uploads the tarball, the CycloneDX SBOM, `SHA256SUMS` and the release notes.
4. `publish` waits for the `release` environment approval, verifies the checksums, refuses a `v<version>` tag on
   another commit, attests provenance and the SBOM, and **stages** the tarball on npm with trusted publishing
   (`npm stage publish --provenance`; never `npm publish`).
5. The owner approves the staged version with 2FA on npmjs.com (*Staged Packages*), after comparing its integrity with
   the one in the job summary.
6. Run *Release* again on `main`: `plan` finds the version on npm without a GitHub Release (mode `release`), rebuilds,
   checks the tarball is identical to npm's, and creates the GitHub Release `v<version>` with the tarball, SBOM,
   `SHA256SUMS` and the Sigstore bundle (`agility-bridge-<v>.intoto.jsonl`).
7. **Image** (P2-18, D-25), in the same runs: `image-build` builds `linux/amd64` and `linux/arm64` from the release
   commit as one OCI archive and smoke-tests and scans the archived amd64 image (`scripts/docker-smoke.ts`, Trivy).
   `image` waits for the same `release` approval as `publish` (one approval covers both), and pushes to
   `ghcr.io/mhidalgo-lab/agility-bridge` only once the version is live on npm — so in step 4's run it stops with a
   notice and step 6's run pushes it. Tags: `X.Y.Z`; `X.Y` and `latest` only when no released version is higher
   (`release.ts image-tags`, never backwards; never `latest` from `release/*`, never either for a prerelease). It
   attests build provenance and the SBOM to the registry (`push-to-registry`).

## Before a release that changes tools (owner)

A release whose `tools/list` changed (a tool added, removed or re-described) carries an **LLM tool-evaluation report**
([Tool evaluations](evals.md), P6-10, L-124): run `pnpm eval:llm --yes` with the default model and with the strongest one
before approving the Version Packages PR, attach the reports to the release notes, and record the tool-choice accuracy.
Any hostile-result scenario the model followed blocks the release. The run spends money and never happens in CI. A
release that did not touch the tools can reuse the last report if the `tools/list` SHA-256 in it is unchanged.

## One-time set-up (owner)

| Setting | Value | Why |
| --- | --- | --- |
| Environment `release` | Required reviewer (the owner), deployment branches `main` and `release/*` only | `publish` waits for this approval. |
| Repository variable `AB_RELEASE_ENABLED` | `true` when the first release is intended | Every build and publish job is skipped without it. |
| npm trusted publisher | `npm trust github agility-bridge --repo mhidalgo-lab/agility-bridge --file release.yml --env release --allow-stage-publish` (no `--allow-publish`) | Only this workflow, in this environment, can stage; nothing can publish directly. |
| npm package publishing access | "Require 2FA and disallow tokens" | No token can publish. |
| Tag ruleset `v*` | Only maintainers create; no update or deletion | `plan` trusts that `v<version>` points at the released commit. |
| Actions | Default `GITHUB_TOKEN` read-only; allow Actions to create pull requests (the version PR) | Each job declares its own permissions. |
| GHCR package `agility-bridge` | After the first push: visibility **public**, linked to this repository (the image's `org.opencontainers.image.source` label links it), Actions access only from this repository | A new container package starts private; `image` pushes with the workflow's `GITHUB_TOKEN`. |

## Dry run (no publishing)

```sh
pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build
node scripts/check-package.ts --out release      # packs, checks and installs the tarball, runs it
node scripts/release.ts notes "$(node -p 'require("./apps/cli/package.json").version')"
cd release && npm publish --dry-run --ignore-scripts "$PWD/agility-bridge-<version>.tgz"
```

## Reruns

| Situation | What happens |
| --- | --- |
| Staged, not approved, workflow rerun | npm refuses a second stage of the same version; the step reports "awaiting approval" and succeeds without a GitHub Release. |
| Approved, no GitHub Release | The next run is mode `release`: nothing is staged, only the GitHub Release is created (the tarball must match npm's `dist.integrity`). |
| Rejected on npmjs.com | Rerun: the version is staged again. |
| `image` failed after the version went live | *Re-run failed jobs* in that run (the plan outputs are reused; a later run would plan `none`). An `X.Y.Z` tag that already exists is never pushed over: the rerun keeps its digest, re-tags and attests it. |

## Egress of the publish and image jobs

`publish` runs harden-runner with `egress-policy: block`: `api.github.com`, `uploads.github.com`,
`token.actions.githubusercontent.com`, `registry.npmjs.org`, `fulcio.sigstore.dev`, `rekor.sigstore.dev`. `image`
allows `api.github.com`, `ghcr.io`, `pkg-containers.githubusercontent.com` (GHCR blob storage),
`token.actions.githubusercontent.com`, `registry.npmjs.org` and the two Sigstore hosts; its list has not run against
GHCR yet, so check the harden-runner log of the first image release. If a run is blocked, add the exact host from the
harden-runner log in a pull request; never a wildcard.
