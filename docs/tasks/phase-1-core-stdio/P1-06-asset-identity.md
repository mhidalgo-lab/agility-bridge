---
id: P1-06
title: Asset identity and name resolution
phase: 1
status: todo
priority: high
depends_on: [P1-03, P1-04]
adr: ["0012"]
lessons: [L-035, L-036, L-064, L-140, L-141, L-145]
owner: ""
---

# P1-06 — Asset identity and name resolution

## Goal
Accept the identifiers people actually use — numbers, OID tokens, names, `me`, `current` — and resolve them safely inside the workspace's scope.

## Scope
- Parse asset numbers and OID tokens (with optional moments).
- Resolve numbers to type + OID with one query across numbered types, using the prefix map only as a hint; verify the result's Agility project.
- Name resolver for Agility projects, teams, members (name, username, `me`), sprints (`current`, `previous`, `next` per team) and statuses per type.
- Exact match first, then candidates with a confidence score (NFKC, case folding, punctuation, trigram similarity); never auto-pick; `AB_AMBIGUOUS` with enveloped candidates.
- `AB_NOT_FOUND` worded as "not found or not visible" — the same for out-of-scope assets.

## Acceptance criteria
- [ ] Tests for every identifier form and cross-type number resolution.
- [ ] An asset outside the workspace's projects yields the same `AB_NOT_FOUND` as a missing one.
- [ ] Ambiguous names return candidates; `me` resolves to the token's member; sprint helpers handle no current sprint and overlapping sprints.

## Security notes
THREAT_MODEL T3, A4.

## Lessons applied
- L-035 — Validate at the domain level before calling upstream.
- L-036 — Name resolution must expose ambiguity.
- L-064 — Recheck results, not only requests.
- L-140 — A 404 means "not found or not visible".
- L-141 — Number prefixes vary per instance.
- L-145 — Single-asset URLs ignore `where`.

## Docs to update
- docs/ARCHITECTURE.md §6.4

## Out of scope
- Anything not listed under Scope.
