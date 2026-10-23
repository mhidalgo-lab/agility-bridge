---
id: P4-13
title: "pnpm cf:setup prompts for the sign-in settings"
phase: 4
status: todo
priority: low
depends_on: [P4-01]
adr: ["0009"]
lessons: [L-026]
owner: ""
---

# P4-13 — `pnpm cf:setup` prompts for the sign-in settings

> Found while building P4-01 (relic-bridge Phase 4 task P4-09): on Workers the client secrets are set by hand today.

## Goal
`pnpm cf:setup --sign-in` sets the public URL and each provider's client id (Worker variables) and client secret
(Worker secrets, through the same `wrangler secret bulk` stdin call as the master key), so no secret reaches an
argument, a variable, a log or a file.

## Scope
- Prompts, or the environment, for `AB_PUBLIC_URL`, `AB_GOOGLE_*`, `AB_GITHUB_*`, `AB_OIDC_*`; the allowlists stay
  dashboard variables and are listed in the deploy guide.

## Acceptance criteria
- [ ] Tests cover the prompts and the environment path; client secrets are never in an argument, log line, printed
  output or `wrangler.<name>.local.jsonc`.
- [ ] `docs/guide/cloudflare-deploy.md` and `docs/guide/identity-providers.md` updated.

## Security notes
THREAT_MODEL T7, T8.

## Lessons applied
- L-026 — Configure secrets through the environment, never through flags.

## Docs to update
- docs/guide/cloudflare-deploy.md, docs/guide/identity-providers.md

## Out of scope
- Real-provider verification (pending decisions, phase 4).
