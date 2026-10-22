---
id: P2-18
title: Publish the Docker image (signed, provenance, latest never backwards)
phase: 2
status: done
priority: medium
depends_on: [P2-11]
adr: ["0003"]
lessons: [L-127, L-128, L-131]
owner: ""
---

# P2-18 — Publish the Docker image (signed, provenance, latest never backwards)

## Goal
Release the image built and tested in P2-11 to `ghcr.io/mhidalgo-lab/agility-bridge` (D-02) with every release, so
self-hosters can pull a verified image instead of building one.

## Scope
- An `image` job in `release.yml` after `publish`, gated like the rest of the release (protected environment,
  `AB_RELEASE_ENABLED`), building `linux/amd64` and `linux/arm64` from the release commit.
- Push to GHCR with `GITHUB_TOKEN` (`packages: write`) only in that job; tags `X.Y.Z`, `X.Y`, and `latest` only when
  the version is the highest released one (never backwards, L-128), computed by a tested script.
- Keyless signature (cosign or GitHub attestations) and SLSA provenance plus an SBOM attestation; the release notes say
  how to verify them (`docs/guide/verify-release.md`).
- `scripts/test/release.test.ts` invariants updated: only the `publish` and `image` jobs mint OIDC tokens; neither runs
  project code beyond the Docker build of the verified commit.

## Acceptance criteria
- [x] A dry run on a fork or a `workflow_dispatch` without push shows the tags it would push and refuses to move
  `latest` backwards (test).
- [x] The first published image verifies with the documented commands; `docker/compose.yaml` switches to the published
  image.

## Decision
D-25 (a), decided by the owner on 2026-10-22: an `image` job behind the `release` approval with GitHub attestations.

## Notes
- Dry run: `GITHUB_REF=refs/heads/main node scripts/release.ts image-tags <version>` prints the references the job
  would push; with `0.1.0` on npm, `0.0.9` gets `0.0.9` and `0.0` but not `latest`, and `release/0.1` never gets
  `latest` (`scripts/test/release.test.ts`).
- v0.2.0 (2026-10-22): `ghcr.io/mhidalgo-lab/agility-bridge:0.2.0` (`sha256:38dca26c…`, linux/amd64 and
  linux/arm64) pulls anonymously, and `gh attestation verify oci://…:0.2.0` passes, as does the tarball's;
  `docker/compose.yaml` pins that digest.

## Security notes
THREAT_MODEL T18.

## Lessons applied
- L-127 — Separate building from publishing.
- L-128 — Releases are idempotent and tags never move backwards.
- L-131 — Guard the release path.

## Docs to update
- docs/dev/releasing.md
- docs/guide/verify-release.md
- docs/guide/self-hosting.md

## Out of scope
- Other registries (Docker Hub) unless the owner asks.
