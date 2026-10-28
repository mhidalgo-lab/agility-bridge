---
id: P5-23
title: Metadata document clients with ports or key-based authentication
phase: 5
status: todo
priority: low
depends_on: [P5-16]
adr: ["0009"]
lessons: [L-088, L-252]
owner: ""
---

# P5-23 — Metadata document clients with ports or key-based authentication

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7). Split from P5-16, which built
> the host allowlist. Not started on purpose: it needs a real client that requires it.

## Goal
Support a client the Client ID Metadata Document draft allows but P5-03 refuses, once a real client (from the client matrix,
[P5-06](P5-06-client-matrix-oauth.md), [P6-14](../phase-6-tool-breadth/P6-14-oauth-client-matrix-rest.md)) shows it needs one.

## Scope
- A client id with a port (`https://host:8443/...`), only if a real client uses one.
- `private_key_jwt` clients and `jwks_uri` documents, only if a real client uses them: key fetching is a second outbound fetch
  per client, so it goes through the same guarded fetcher with the same size, time and redirect bounds, counts against the same
  fetch budgets and honours `AB_OAUTH_CIMD_HOSTS` for the key host.
- Evidence first: record which client needs which feature, with the date, in `docs/RESEARCH.md`.

## Acceptance criteria
- [ ] The client that needs it is named in the research notes, with the document shape it sends (sanitized).
- [ ] Any extra fetch uses the guarded fetcher with the same bounds; negative tests for private addresses, redirects and oversize
  key sets on memory, SQLite and workerd/D1.
- [ ] THREAT_MODEL T10, T11 updated.

## Security notes
THREAT_MODEL T10, T11 (every extra fetch is a new SSRF surface, L-088).

## Lessons applied
- L-088 — Client metadata fetching is an SSRF surface.
- L-252 — Rebuild a registration request from an allowlist of fields.

## Docs to update
- docs/dev/oauth.md, docs/guide/configuration.md, docs/RESEARCH.md

## Out of scope
- Clients nobody uses.
