---
id: P4-01
title: Identity providers and owner bootstrap
phase: 4
status: todo
priority: high
depends_on: [P3-11]
adr: ["0009"]
lessons: [L-085, L-091, L-092]
owner: ""
---

# P4-01 — Identity providers and owner bootstrap

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Admins and members sign in with Google, GitHub, Cloudflare Access or any OIDC provider; nobody gets in by default.

## Scope
- Redirect providers (OIDC discovery, Google preset with hosted-domain check, GitHub OAuth app) and the Cloudflare Access header provider (JWT verified against the team keys and audience).
- Sign-in transactions in `kv` (PKCE verifier, nonce, provider, target path, browser binding), consumed once.
- One `(idp, subject)` identity per user; verified email binds only an unbound user; allowlists and optional auto-provisioning; deny by default.
- Single-use owner setup link with the code in the URL fragment; redirect targets validated after parsing.

## Acceptance criteria
- [ ] Tests for each provider, replayed transactions, open-redirect attempts (dot segments), identity conflicts.

## Security notes
THREAT_MODEL T11, T14.

## Lessons applied
- L-085 — One-time secrets never travel in URLs.
- L-091 — Validate redirect targets after parsing.
- L-092 — One identity per user.

## Docs to update
- docs/guide/identity-providers.md (new)

## Out of scope
- Anything not listed under Scope.
