---
id: P5-16
title: Metadata document policy extras
phase: 5
status: todo
priority: low
depends_on: [P5-06]
adr: ["0009"]
lessons: [L-088, L-252]
owner: ""
---

# P5-16 — Metadata document policy extras

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7). Created by P5-03.

## Goal
Operators can restrict which metadata-document clients may connect, and clients the draft allows but P5-03 refuses can
be supported when a real one needs them.

## Scope
- An optional allowlist of client id hosts (`AB_OAUTH_CIMD_HOSTS`) for deployments that only want known clients.
- Ports in client ids and `private_key_jwt` / `jwks_uri` clients, only if the client matrix shows one that needs them
  (every extra fetch is a new SSRF surface, L-088).

## Acceptance criteria
- [ ] An allowlisted deployment refuses every other client id before any fetch (tested on all hosts).
- [ ] Any extra fetch goes through the same guarded fetcher with the same bounds.

## Security notes
THREAT_MODEL T10, T11.

## Lessons applied
- L-088 — Client metadata fetching is an SSRF surface.
- L-252 — Rebuild a registration request from an allowlist of fields.

## Docs to update
- docs/dev/oauth.md, docs/guide/configuration.md

## Out of scope
- Anything not listed under Scope.
