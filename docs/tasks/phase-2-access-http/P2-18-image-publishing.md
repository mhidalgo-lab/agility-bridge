---
id: P2-18
title: Publish the Docker image (signed, provenance, latest never backwards)
phase: 2
status: blocked
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
- [ ] A dry run on a fork or a `workflow_dispatch` without push shows the tags it would push and refuses to move
  `latest` backwards (test).
- [ ] The first published image verifies with the documented commands; `docker/compose.yaml` switches to the published
  image.

## Blocker
Pushing an image to a registry needs the owner's approval, and the job changes a release invariant (decision D-25 in
[pending decisions](../../pending-decisions/phase-2.md)).

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
