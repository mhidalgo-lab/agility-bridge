---
id: P3-05
title: Cloudflare setup script
phase: 3
status: done
priority: high
depends_on: [P3-02]
adr: []
lessons: [L-100]
owner: ""
---

# P3-05 — Cloudflare setup script

> Refined 2026-10-22 (tasks/README rule 7).

## Goal
One idempotent command creates or updates a deployment per environment.

## Scope
- `pnpm cf:setup --name <worker>` (`scripts/cf-setup.ts`), driving `wrangler` (logged in by the operator; no
  Cloudflare token in the repository or on the command line):
  - checks the name (`agility-bridge` or `agility-bridge-<suffix>`, lower case) and that wrangler is logged in;
  - finds or creates the D1 database of the same name and keeps its id in an **ignored local config**
    (`apps/worker/wrangler.<name>.local.jsonc`) built from the committed `wrangler.jsonc` (which holds no ids), with
    `keep_vars: true` so variables set in the dashboard survive a deploy, and `AB_PLAN` (`--plan`, default `free`);
  - deploys, then sets only the **missing** secrets (`AB_MASTER_KEY`, `AB_ADMIN_TOKEN`) through stdin, never as
    arguments or `vars`;
  - checks `/health` on the deployed URL.
- Secrets: a secrets file (`--secrets-file`, created `0600`, refused if it exists) is opened **before** anything is
  generated; values are written to it, and printed only with `--show-secrets`; with neither, the script refuses to
  generate (the operator would lose the master key).
- Separation (T34): every resource is named after `--name`; a local config whose worker or database name differs
  from `--name` is refused; `agility-bridge` (production) never gets `AB_ENVIRONMENT=test`.
- `--dry-run` prints the plan without changing anything.

## Acceptance criteria
- [x] Tests with a fake wrangler: a first run creates the database, writes the local config, deploys and sets both
      secrets; a second run is a no-op apart from the deploy (no new database, no secret changed); a name mismatch and
      an existing secrets file are refused before anything changes; nothing is generated when the secrets file cannot
      be created.
- [x] A real run creates `agility-bridge-staging` (owner-approved name) and a second run changes nothing; `/health`
      answers.
- [x] `docs/guide/cloudflare-deploy.md` (first version; P3-07 completes it).

## Security notes
THREAT_MODEL T34.

## Lessons applied
- L-100 — Setup scripts are idempotent per environment.

## Docs to update
- docs/guide/cloudflare-deploy.md

## Notes
- Real run, 2026-10-22: `agility-bridge-staging` created on the owner's account (Free plan, `workers.dev`); the first
  health check got `403` because the Worker had no `AB_PUBLIC_URL` (L-180), so the script now sets it from the
  deployed address and redeploys once. A further run only redeployed. On the deployment: `/health` 200 with HSTS, the
  admin API 401 without and 200 with the break-glass token, MCP 401 without a token.

## Out of scope
- Custom domains and the CI deploy workflow (P3-07, P3-11); rotating existing secrets (`keys rotate`, P3-08).
