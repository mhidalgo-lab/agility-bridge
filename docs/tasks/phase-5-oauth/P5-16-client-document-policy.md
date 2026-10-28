---
id: P5-16
title: Metadata document policy extras
phase: 5
status: done
priority: low
depends_on: [P5-06]
adr: ["0009"]
lessons: [L-088, L-252]
owner: "agent"
---

# P5-16 — Metadata document policy extras

> Refined 2026-10-28. Built here: the host allowlist. Ports and key-based (`private_key_jwt`, `jwks_uri`) document clients
> need a real client that requires them (L-088: every extra fetch is a new SSRF surface), so they moved to
> [P5-23](P5-23-cimd-ports-and-key-clients.md). Created by P5-03.

## Goal
Operators can restrict which metadata-document clients may connect, and clients the draft allows but P5-03 refuses can
be supported when a real one needs them.

## Scope
- `AB_OAUTH_CIMD_HOSTS` (`clientMetadataHosts`): a comma-separated list of host names (at most 50, validated like
  `AB_OAUTH_DCR_REDIRECT_HOSTS`). Unset = any public host, as before. Set = a client id URL whose host is not exactly on the
  list is refused as `client_host_not_allowed` by the same check that refuses the other malformed ids, before the cache, the
  budgets and any fetch. A document stored before the list was set is refused too (the check comes first). Exact host match:
  no wildcard and no subdomains (D-133).
- The refusal is the generic `invalid_client` of the other document refusals, with the reason in the log only (no audit row: an
  anonymous caller must not be able to write rows, T20).
- Dynamic registration is unchanged (it has its own redirect-host list).

## Acceptance criteria
- [x] An allowlisted deployment refuses every other client id before any fetch, a listed one still connects (tested on memory,
  SQLite and workerd/D1: the fake document origin sees no request for the refused id).
- [x] The setting is validated and registered for both hosts.
- [x] Ports and key-based clients are a separate, evidence-gated task (P5-23), so the extra-fetch criterion has nothing to cover here.

## Security notes
THREAT_MODEL T10, T11.

## Lessons applied
- L-088 — Client metadata fetching is an SSRF surface.
- L-252 — Rebuild a registration request from an allowlist of fields.

## Docs to update
- docs/dev/oauth.md, docs/guide/configuration.md

## Out of scope
- Ports in client ids and key-based document clients ([P5-23](P5-23-cimd-ports-and-key-clients.md)).
