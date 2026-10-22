---
id: P3-07
title: Cloudflare docs (deploy, limits, costs, custom domain)
phase: 3
status: review
priority: medium
depends_on: [P3-05]
adr: ["0014"]
lessons: [L-028, L-133]
owner: ""
---

# P3-07 — Cloudflare docs (deploy, limits, costs, custom domain)

> Refined 2026-10-22 (tasks/README rule 7).

## Goal
An operator deploys to a Cloudflare account by following the guide literally.

## Scope
- `docs/guide/cloudflare-deploy.md` completed: prerequisites, deploy, first setup, **custom domain**
  (`pnpm cf:setup --domain mcp.example.com`: a Workers custom domain, the domain as `AB_PUBLIC_URL`, `workers.dev`
  turned off), the **WAF / Browser Integrity Check / Bot Fight Mode exception** for the MCP paths (L-028), which Agility
  instances a Worker can reach (internet-facing with a publicly trusted certificate; on-premises through a Cloudflare
  Tunnel with a public hostname, or `agility-bridge serve` instead, ADR-0014), and costs (Free vs Paid: requests, CPU,
  D1 rows, rate limits).
- `cf:setup --domain`: tested with the fake wrangler.
- Verification notes (`docs/dev/verification.md`): what was executed against `agility-bridge-staging` and when.
- Owner steps in `docs/pending-decisions/phase-3.md` for what needs the owner's account or tokens: a custom domain on a
  zone, an Agility credential on the Worker.

## Acceptance criteria
- [x] Every command of the guide that needs no owner resource was executed against staging and recorded; the others are
      owner steps.
- [x] `cf:setup --domain` tested; the guide's links and commands checked by the docs check.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-028 — Edge bot protection can block MCP clients.
- L-133 — Execute the documentation.

## Docs to update
- docs/guide/cloudflare-deploy.md, docs/guide/cloudflare-limits.md, docs/dev/verification.md

## Out of scope
- A CI deploy workflow (P3-11 decides).
