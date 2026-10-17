---
id: P2-14
title: Pass-through workspaces (optional, off by default)
phase: 2
status: todo
priority: low
depends_on: [P2-06, P2-08]
adr: ["0008", "0009"]
lessons: [L-055, L-063, L-069]
owner: ""
---

# P2-14 — Pass-through workspaces (optional, off by default)

## Goal
A simple shared team server where each client sends its own Agility token and nothing is stored — without bypassing any workspace control.

## Scope
- `AB_PASSTHROUGH=on` enables a workspace setting `credential_source: passthrough`; such a workspace keeps its normal URL `/w/{slug}/mcp`.
- The caller sends its Agility token in `X-Agility-Token` instead of a device token; HTTPS required; never persisted; validated against the workspace's instance; audited by an HMAC fingerprint; short-lived identity cache.
- Every workspace control applies unchanged: Agility projects, asset types, tool groups, limits, rate limits (per token fingerprint).
- Read-only in 1.0: write tools are never registered on a pass-through workspace.

## Acceptance criteria
- [ ] Tests: missing header, HTTP refused, token for another instance refused, workspace limits enforced, no token in logs or audit, write tools absent.
- [ ] Decision D-04 recorded (keep, defer or drop).

## Security notes
THREAT_MODEL T12, A9.

## Lessons applied
- L-055 — Credentials never follow redirects, and the upstream URL never comes from a request.
- L-063 — Effective permissions are intersections, resolved once and rechecked.
- L-069 — Prefer bring-your-own-token.

## Docs to update
- docs/guide/self-hosting.md (pass-through section)

## Out of scope
- Anything not listed under Scope.
