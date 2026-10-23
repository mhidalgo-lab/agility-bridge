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
- Add scenarios to `scripts/worker-bench.ts` using the http-app test world with a signed-in session (`helpers/panel.ts`),
  in the Workers configuration (request isolation, as the Worker runs):
  - `cold: first /admin` — in a fresh process (nine of them, fastest, after a forced GC, like the cold boot): the first
    signed-in `GET /admin`, which imports the panel and builds its Hono app (P3-14). The second request is reported too,
    to show the first one carried the load.
  - warm (median of 25 after warm-up): `admin: overview`, `admin: users list` (100 users, the 25-row page), `admin: audit`
    (200 rows), `admin: asset` (the CSS), and `admin: form POST` (create a user through the in-process admin API).
  - Agility requests per scenario (the fake's call log); expected 0.
- Baselines in `scripts/bench/worker-baseline.json`, flagged by the same 2x rule; new keys are not flagged.
- Record the numbers in `docs/guide/cloudflare-limits.md` next to the MCP paths, and say whether the panel's first request
  fits the Free plan's CPU budget (D-27 accepted an overrun for the first MCP request only). A warm page above 10 ms is
  recorded with its cause; a larger fix becomes its own task.

## Acceptance criteria
- [ ] The scenarios run in `pnpm bench:worker` and appear in the baseline.
- [ ] The first-request cost of the panel is documented, with the Paid-plan note if it does not fit the Free budget.
- [ ] Every panel scenario reports 0 Agility requests; the regression test covers the new keys.

## Docs to update
- docs/guide/cloudflare-limits.md, docs/dev/admin-ui.md

## Out of scope
- Measuring on Cloudflare itself (`wrangler tail`, L-182): that needs a deploy and stays an owner-approved step.
