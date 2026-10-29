---
id: P4-39
title: An unbind claim names only a configured provider
phase: 4
status: todo
priority: medium
depends_on: [P4-24]
adr: []
lessons: [L-121]
owner: ""
---

# P4-39 — An unbind claim names only a configured provider

## Goal
A typo in the provider of a named unbind (P4-24) no longer locks the account until the claim expires: the owner decided D-130
(b) on 2026-10-29. The admin API refuses a provider this deployment has not configured, and the panel offers only the
configured ones.

## Scope
- Pass the deployment's configured sign-in providers (their `idp` names) to the admin API and the panel; the HTTP and Worker
  hosts both know them from their identity settings.
- `POST /users/{id}/unbind` with a `provider` that is not configured answers 422 (`AB_INPUT_INVALID`) and changes nothing:
  no claim, no unbind, an audit row only if the existing route audits refusals.
- The panel's unbind form shows a select of the configured providers (plus "any provider"), not a free text field.
- The CLI `user unbind --to` gets the same refusal through the API (local mode validates against the same list).

## Acceptance criteria
- [ ] An unknown provider is refused before anything is written; a configured one behaves as in P4-24.
- [ ] Negative authorization tests unchanged and passing; a test for the refusal on the API, the panel and the CLI.
- [ ] Docs (identity-providers guide, admin API reference) say the provider must be configured.

## Security notes
THREAT_MODEL T14: the claim narrows who can bind; a refused claim must leave the account as it was.

## Lessons applied
- L-121 — Negative authorization is first-class.

## Docs to update
- docs/guide/identity-providers.md, the generated admin API and CLI references

## Out of scope
- Several identities per user (D-30).
