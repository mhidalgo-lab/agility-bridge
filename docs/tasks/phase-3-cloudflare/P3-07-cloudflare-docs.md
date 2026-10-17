---
id: P3-07
title: Cloudflare docs (deploy, limits, costs, custom domain)
phase: 3
status: todo
priority: medium
depends_on: [P3-05]
adr: ["0014"]
lessons: [L-028, L-133]
owner: ""
---

# P3-07 — Cloudflare docs (deploy, limits, costs, custom domain)

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
An operator deploys to a clean Cloudflare account by following the guide literally.

## Scope
- Deploy guide, limits and costs, custom domain, WAF/Browser Integrity exception for MCP clients.
- Which Agility instances a Worker can reach (public, publicly trusted certificates) and the tunnel option.

## Acceptance criteria
- [ ] Guide executed on a clean account and recorded in the verification notes.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-028 — Edge bot protection can block MCP clients.
- L-133 — Execute the documentation.

## Docs to update
- docs/guide/cloudflare-deploy.md
- docs/guide/cloudflare-limits.md

## Out of scope
- Anything not listed under Scope.
