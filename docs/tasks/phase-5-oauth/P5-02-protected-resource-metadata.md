---
id: P5-02
title: Protected resource metadata per workspace
phase: 5
status: todo
priority: high
depends_on: [P5-01]
adr: ["0009"]
lessons: [L-067, L-087]
owner: ""
---

# P5-02 — Protected resource metadata per workspace

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Clients discover how to authenticate for exactly one workspace.

## Scope
- RFC 9728 metadata per `/w/{slug}/mcp`; 401 challenges naming it (built from the path alone); RFC 8707 audience checks.

## Acceptance criteria
- [ ] A token for workspace A fails at B; refresh cannot retarget; unknown slugs answer like wrong tokens.

## Security notes
THREAT_MODEL T2, T19.

## Lessons applied
- L-067 — Bind each token to one workspace.
- L-087 — One protected resource per workspace.

## Docs to update
- docs/guide/oauth.md (new)

## Out of scope
- Anything not listed under Scope.
