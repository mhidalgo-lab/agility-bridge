---
id: P4-13
title: "pnpm cf:setup prompts for the sign-in settings"
phase: 4
status: done
priority: low
depends_on: [P4-01]
adr: ["0009"]
lessons: [L-026, L-223]
owner: ""
---

# P4-13 — `pnpm cf:setup` prompts for the sign-in settings

> Found while building P4-01 (relic-bridge Phase 4 task P4-09): on Workers the client secrets are set by hand today.

## Goal
`pnpm cf:setup --sign-in` asks which identity providers to configure and sets each provider's non-secret settings (Worker
variables, in the ignored local wrangler config) and client secret (Worker secret, through `wrangler secret put` on stdin,
like the master key), so no secret reaches an argument, a variable, a log, stdout or any file but Cloudflare's store.
Every value is validated by the parser the server boots with (`identitySettingsFromEnv`), so a bad value fails at setup,
not at the first request.

## Scope
- `--sign-in` (off by default: a plain run never prompts and never changes sign-in values).
- Sources, in order: the environment (`AB_GOOGLE_*`, `AB_GITHUB_*`, `AB_OIDC_*`, `AB_CF_ACCESS_*`, `AB_LOGIN_*`: the
  non-interactive mode for CI), then terminal prompts (client secrets read without echo). With neither, nothing is
  asked and existing values stay. A provider is configured when its client id (or Access team) is in the environment, or
  when named at the "which providers" prompt.
- The public URL is not asked: it is `--domain`, `--public-url`, the value of the previous run, or the `workers.dev`
  address learnt from the first deploy (the deploy guide recommends `--domain`, because the provider callback URLs are
  registered against it).
- The allowlists and `AB_LOGIN_AUTO_PROVISION` are asked too (decision D-47: the first draft left them to the dashboard);
  the server's warnings (allowlist with auto-provisioning off, auto-provisioning without an allowlist, `admin`) are
  printed at setup.
- Idempotent: variables of a previous run are carried into the regenerated local config; an empty answer keeps a value
  (and a stored secret); `-` clears an optional variable. A secret is put only when one is given now.
- Prints the callback URLs to register (`<public URL>/auth/callback/<provider id>`, from the server's own
  `providerRouteId`).
- Client secrets are not copied to `--secrets-file`: the identity provider holds them (D-47).

## Acceptance criteria
- [x] Tests (fake wrangler) cover the prompts, the environment path, idempotent re-runs, validation failures
  (bad value, half-configured provider, missing secret, bad public URL), the warnings and the printed callback URLs.
- [x] Client secrets are never in an argument, log line, printed output, the local config or the secrets file; they reach
  wrangler only through stdin.
- [x] `docs/guide/cloudflare-deploy.md` and `docs/guide/identity-providers.md` updated.

## Outcome
- Built as scoped, in `scripts/cf-setup-sign-in.ts` (collection and validation) and `scripts/cf-setup.ts` (wiring).
  Validation runs `identitySettingsFromEnv` before the first Cloudflare call that creates anything; a stored secret counts
  as present when no new one is given.
- Decision D-47 (allowlists asked too; client secrets never copied to `--secrets-file`). Lesson L-223.
- Not done: removing a provider from the script (edit the local config, delete the secret in the dashboard); reading
  secrets from a `_FILE` path (the environment or the terminal only).

## Security notes
THREAT_MODEL T7, T8.

## Lessons applied
- L-026 — Configure secrets through the environment, never through flags.
- L-223 — Added by this task (validate with the server parser; one destination for a secret).

## Docs to update
- docs/guide/cloudflare-deploy.md, docs/guide/identity-providers.md

## Out of scope
- Real-provider verification (pending decisions, phase 4).
