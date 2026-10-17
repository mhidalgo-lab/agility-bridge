---
id: P2-11
title: Docker image
phase: 2
status: todo
priority: medium
depends_on: [P2-06]
adr: ["0006"]
lessons: [L-102, L-128]
owner: ""
---

# P2-11 — Docker image

## Goal
A small, hardened, multi-architecture image for self-hosting.

## Scope
- Multi-stage build on a digest-pinned Node 24 image; distroless non-root runtime; read-only root filesystem; `/data` volume; Node-based healthcheck; OCI labels.
- Signed images with provenance; `latest` never moves backwards.
- Compose example with a reverse proxy.

## Acceptance criteria
- [ ] Smoke test in CI against a fake Agility upstream; image scan with no high/critical findings.

## Security notes
THREAT_MODEL T18.

## Lessons applied
- L-102 — Keep the Node footprint portable.
- L-128 — Releases are idempotent and tags never move backwards.

## Docs to update
- docs/guide/self-hosting.md

## Out of scope
- Anything not listed under Scope.
