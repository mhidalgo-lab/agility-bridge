---
id: P5-15
title: Private-use scheme redirects for desktop clients
phase: 5
status: todo
priority: low
depends_on: [P5-06]
adr: ["0009"]
lessons: [L-091, L-252]
owner: ""
---

# P5-15 — Private-use scheme redirects for desktop clients

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7). Created by P5-03 (D-69).

## Goal
Decide, from the client matrix (P5-06), whether a client we support needs a private-use scheme callback (`cursor://...`),
and if so accept it safely.

## Scope
- Only if P5-06 shows a client that cannot use https or loopback: turn on the provider's `allowPrivateUseRedirectUris`,
  accept the scheme in `redirectUriVerdict` for dynamic clients (not for metadata documents), require a dotted
  reverse-domain-style scheme where the client allows it (RFC 8252 section 7.1), and make the consent screen (P5-04) show
  the full callback.

## Acceptance criteria
- [ ] The decision and its evidence (which client, which callback) are recorded in D-69.
- [ ] If accepted: validation matrix, consent display and negative tests (`javascript:`, `data:`, no dot) pass on all hosts.

## Security notes
THREAT_MODEL T9, T10.

## Lessons applied
- L-091 — Validate redirect targets after parsing.
- L-252 — Rebuild a registration request from an allowlist of fields.

## Docs to update
- docs/dev/oauth.md, docs/pending-decisions/phase-5.md

## Out of scope
- Anything not listed under Scope.
