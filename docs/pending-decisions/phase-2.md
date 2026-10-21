# Pending decisions — Phase 2

> Open questions and owner steps from Phase 2. Answer inline (`**Owner:** …` with a date).

## Owner steps

1. **Required checks**: the CI job **"Docker image (build, smoke test, scan)"** (P2-11) is new. Add it to the
   ruleset's required checks if it should block merges (`docs/security/repo-settings.md`); until then it runs on every
   PR but does not block.

## Open decisions

### D-25 — Publishing the Docker image *(P2-11, P2-18)*
- **Context:** P2-11 builds, smoke-tests and scans the image in CI and never pushes it. Publishing needs your approval,
  a GHCR package (`ghcr.io/mhidalgo-lab/agility-bridge`, D-02), and an `image` job in `release.yml` that pushes and
  signs. Today only the npm `publish` job may mint an OIDC token (tested invariant); keyless signing needs one in the
  image job too.
- **Options:** (a) an `image` job in the release workflow after the npm publish, behind the same `release` environment
  approval, signing keylessly with GitHub artifact attestations (provenance + SBOM), tags `X.Y.Z`, `X.Y` and `latest`
  only when it is the highest version; (b) the same with cosign keyless signatures in addition (verifiable with
  `cosign verify`); (c) no published image for now (self-hosters build it; documented).
- **Recommendation:** (a): one approval publishes npm and the image, GitHub attestations verify with
  `gh attestation verify` like the npm tarball, and no extra signing tool enters the pipeline. P2-18 implements it once
  you agree.
