# Pending decisions — Phase 2

> Open questions and owner steps from Phase 2. Answer inline (`**Owner:** …` with a date).

## Owner steps

1. ~~**Required checks**: add **"Docker image (build, smoke test, scan)"** (P2-11) to the rulesets.~~ Done
   2026-10-22 (both rulesets, `docs/security/repo-settings.md`).
4. **First image release** (P2-18): after the first run that pushes the image, make the GHCR package
   `agility-bridge` public and check the `image` job's harden-runner log ([releasing](../dev/releasing.md)); then
   `docker/compose.yaml` can switch to the published image.
2. **Client runs over HTTP** (P2-17): connect VS Code, JetBrains, Copilot CLI, Claude Code and Cursor to
   `agility-bridge serve` (`https://<host>/w/<slug>/mcp`, a device token in the `Authorization` header, as in
   [devices](../guide/multi-device.md)) and record the versions in the
   [client matrix](../reference/client-compatibility.md). MCP Inspector CLI 2.11.0 is verified.
3. **Release v0.2**: the Version Packages PR collects the Phase 2 changesets; merging it and approving the `release`
   environment publishes `agility-bridge` to npm (Phase 1 owner steps still apply: P1-14 client runs, release set-up).

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
- **Owner (2026-10-22):** Decided: (a), the release job. Implemented in P2-18.

### D-26 — Go for Phase 3 *(P2-17)*
- **Context:** the [Phase 2 review](../reviews/phase-2-review.md) found one high, four medium and five low issues; all
  but two are fixed here with mutation-checked regression tests. P2-19 (plain-HTTP instance URLs in `serve`) is a
  follow-up; the pass-through timing difference is accepted. Live: the read-only suite and the new server check pass.
- **Options:** (a) go for Phase 3 now, P2-19 in parallel; (b) go after P2-19 and the owner's client runs; (c) hold.
- **Recommendation:** (a): P2-19 hardens `serve` only and does not touch the edge work; the client runs repeat
  transports already verified against the spike in P0-07.
