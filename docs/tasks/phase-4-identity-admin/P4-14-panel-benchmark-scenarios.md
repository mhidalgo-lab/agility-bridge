---
id: P4-14
title: CPU benchmark scenarios for the panel
phase: 4
status: todo
priority: low
depends_on: [P4-03]
adr: ["0010"]
lessons: [L-097, L-182]
owner: ""
---

# P4-14 — CPU benchmark scenarios for the panel

> Found while building P4-03 (relic-bridge's Phase 4 review, Q3: its benchmark had no admin scenario).

## Goal
`pnpm bench:worker` measures the panel's request paths, so a change that makes the overview or the asset route expensive on
the Free plan's CPU budget is flagged like a slow MCP path.

## Scope
- Add scenarios to `scripts/worker-bench.ts` (request isolation, as the Worker runs): a signed-in `GET /admin` (session
  lookup, the admin API call for the user list, rendering), `GET /admin/assets/<css>`, and the first panel request after a
  cold boot (module load and the panel's Hono app build), each with its Agility-free storage calls counted.
- Baselines in `scripts/bench/worker-baseline.json` (`--update` on a quiet machine), flagged by the same 2x rule.
- Record the numbers in `docs/guide/cloudflare-limits.md` next to the MCP paths, and say whether the panel's first request
  fits the Free plan's CPU budget (D-27 accepted an overrun for the first MCP request only).

## Acceptance criteria
- [ ] The scenarios run in `pnpm bench:worker` and appear in the baseline.
- [ ] The first-request cost of the panel is documented, with the Paid-plan note if it does not fit the Free budget.

## Docs to update
- docs/guide/cloudflare-limits.md, docs/dev/admin-ui.md

## Out of scope
- Measuring on Cloudflare itself (`wrangler tail`, L-182): that needs a deploy and stays an owner-approved step.
