---
id: P2-11
title: Docker image
phase: 2
status: review
priority: medium
depends_on: [P2-06]
adr: ["0006"]
lessons: [L-102, L-128]
owner: "Matias Hidalgo"
---

# P2-11 — Docker image

## Goal
A small, hardened, multi-architecture image for self-hosting.

## Scope
- Multi-stage build on a digest-pinned Node 24 image; distroless non-root runtime; read-only root filesystem; `/data` volume; Node-based healthcheck; OCI labels.
- Signed images with provenance; `latest` never moves backwards.
- Compose example with a reverse proxy.

## Acceptance criteria
- [x] Smoke test in CI against a fake Agility upstream; image scan with no high/critical findings. *(CI job "Docker
  image (build, smoke test, scan)": `scripts/docker-smoke.ts` runs the image non-root and read-only next to the
  synthetic Agility in its network namespace, sets up a workspace through the admin API, calls a tool, checks refusals,
  the healthcheck and the logs; Trivy 0.75.0 (pinned and checksummed) finds no fixable high/critical issue; a
  `linux/amd64` + `linux/arm64` build runs without emulation.)*

## Notes
- `docker/Dockerfile`: build stage on `$BUILDPLATFORM` (`pnpm deploy --prod` of the CLI), runtime
  `gcr.io/distroless/nodejs24-debian13:nonroot` pinned by digest, `/data` owned by 65532 with mode 0700, Node
  healthcheck, OCI labels. `docker/compose.yaml` + `docker/Caddyfile`: TLS proxy, read-only, no capabilities.
- **Split out:** "Signed images with provenance; `latest` never moves backwards" needs a registry push (owner approval)
  and a change to a release invariant → P2-18, blocked on decision D-25.

## Security notes
THREAT_MODEL T18.

## Lessons applied
- L-102 — Keep the Node footprint portable.
- L-128 — Releases are idempotent and tags never move backwards.

## Docs to update
- [x] docs/guide/self-hosting.md (Docker section; P2-16 completes the guide)

## Out of scope
- Anything not listed under Scope.
