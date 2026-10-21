# Releasing

Releases follow ADR-0003 and THREAT_MODEL T18: build and publish are separate jobs, only the publish job can mint an
OIDC token and it runs no project code, and a version goes live only after **two** approvals (the GitHub `release`
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

## One-time set-up (owner)

| Setting | Value | Why |
| --- | --- | --- |
| Environment `release` | Required reviewer (the owner), deployment branches `main` and `release/*` only | `publish` waits for this approval. |
| Repository variable `AB_RELEASE_ENABLED` | `true` when the first release is intended | Every build and publish job is skipped without it. |
| npm trusted publisher | `npm trust github agility-bridge --repo mhidalgo-lab/agility-bridge --file release.yml --env release --allow-stage-publish` (no `--allow-publish`) | Only this workflow, in this environment, can stage; nothing can publish directly. |
| npm package publishing access | "Require 2FA and disallow tokens" | No token can publish. |
| Tag ruleset `v*` | Only maintainers create; no update or deletion | `plan` trusts that `v<version>` points at the released commit. |
| Actions | Default `GITHUB_TOKEN` read-only; allow Actions to create pull requests (the version PR) | Each job declares its own permissions. |

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

## Egress of the publish job

`publish` runs harden-runner with `egress-policy: block`: `api.github.com`, `uploads.github.com`,
`token.actions.githubusercontent.com`, `registry.npmjs.org`, `fulcio.sigstore.dev`, `rekor.sigstore.dev`. If a run is
blocked, add the exact host from the harden-runner log in a pull request; never a wildcard.
