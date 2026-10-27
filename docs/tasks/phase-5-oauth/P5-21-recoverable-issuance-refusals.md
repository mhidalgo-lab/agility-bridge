---
id: P5-21
title: Keep the device when an issuance refusal can pass
phase: 5
status: todo
priority: low
depends_on: [P5-10]
adr: ["0009"]
lessons: [L-267, L-121]
owner: ""
---

# P5-21 — Keep the device when an issuance refusal can pass

> Created by the Phase 5 review (P5-10). Refined 2026-10-27 after the owner decided
> [D-77](../../pending-decisions/phase-5.md) (b).

## Goal
A workspace switched off for maintenance, a person disabled for a while or a credential that is replaced a day later does not
cost every connected app its approval. Today any refusal when a token is issued ends the device (the provider revokes the
grant on `invalid_grant`), so each app has to be approved again after the fix.

## Scope
- In `checkIssuance` (code exchange and refresh) and the repeat path of the refresh family, split the access refusals into
  final ones (`grant_revoked`, `grant_expired`, `user_missing`, `grant_missing`, `wrong_workspace`, `workspace_missing`,
  `principal_mismatch`, `oauth_mismatch`, `client_revoked`; plus the reasons the list did not name, all fail closed as final:
  `token_revoked`, `token_expired`, `instance_missing`, `credential_missing`, `credential_mismatch`, `malformed_policy`,
  `not_passthrough`) and recoverable ones (`workspace_disabled`, `instance_disabled`,
  `user_disabled`, `credential_revoked`, `credential_unvalidated`, `no_projects`, `no_tools`). Final ones keep ending the
  device; recoverable ones answer `503 temporarily_unavailable` with `Retry-After` and keep it, writing an
  `oauth.token.refused` row with `revoked: false`.
- The class lives next to `DenyReason` in `packages/auth` as an exhaustive `Record<DenyReason, 'final' | 'recoverable'>`; the
  OAuth server asks it (the `OAuthDenyReason`s `principal_mismatch`, `oauth_mismatch`, `client_revoked` are final).
- The `503` carries `Retry-After` (60 s) and writes `oauth.token.refused` with `revoked: false`; it is not counted as a token
  failure by the abuse limiter (not a `4xx`).
- A recoverable refusal at a **code exchange** still spends the code (it is single use) and ends nothing else; a later
  presentation of that code is a replay like any other (the unredeemed approval has no tokens and ends).
- A new ADR (0018) states what "revoke on refusal" in ADR-0009 now means (amends, does not edit it).
- State the rule in the "how it works" guide (what a refresh does for each reason) and the troubleshooting page.

## Acceptance criteria
- [ ] Each reason is in exactly one class, and a test fails when a new `DenyReason` is not classified.
- [ ] A refresh refused for a recoverable reason leaves the device and its refresh token working once the reason is gone, and the
  access token is still refused per request meanwhile (negative authorization tests: no upstream call, no data).
- [ ] A final reason still revokes the device and its tokens at once, as today.
- [ ] Mutation-checked on memory, SQLite and workerd/D1.

## Security notes
THREAT_MODEL T9, T15. Nothing is weakened for a device that is kept: every MCP request re-runs the same decision and is refused
while the reason holds. Disabling a person or a workspace must still stop access within the cache lifetime.

## Lessons applied
- L-267 — A passing failure must not look like a verdict on the client.
- L-121 — Negative authorization is first-class.

## Docs to update
- docs/guide/oauth-how-it-works.md, docs/guide/oauth-troubleshooting.md, docs/dev/oauth.md, docs/THREAT_MODEL.md, a new ADR

## Out of scope
- Idle expiry of devices (P5-14).
