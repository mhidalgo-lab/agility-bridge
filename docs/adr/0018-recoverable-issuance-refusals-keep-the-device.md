# ADR-0018 — A refusal at token issuance that can pass keeps the OAuth device

- **Status:** accepted (owner, 2026-10-27, D-77 (b))
- **Date:** 2026-10-27
- **Amends:** the "revoke on refusal" behaviour that [ADR-0009](0009-authentication.md) §3 and P5-01 gave the OAuth token
  endpoint (every refusal of an issuance ended the device). ADR-0009 is not edited; this record says what now holds.
- **Related:** P5-21, P5-01, P5-05, [D-77](../pending-decisions/phase-5.md), L-267, L-121, THREAT_MODEL T9, T15

## Context

Every token issuance (code exchange, refresh, and a repeat inside the refresh reuse window) re-runs the access decision
for the grant the device was approved with. A refusal was `invalid_grant`, and on `invalid_grant` the provider revokes the
device's whole grant. Most refusals are final (grant revoked or expired, person gone). Some pass: a workspace or instance
switched off for maintenance, a person disabled for a while, a credential replaced a day later. A device token comes back
to life when that is fixed; an OAuth device had to be approved again, and the client saw its tokens refused with no hint
that waiting would have been enough.

## Decision

1. Every `DenyReason` is in exactly one class, in `packages/auth/src/access/deny-class.ts` (an exhaustive `Record`, plus a
   test that compares it with the union's source):
   - **final:** `wrong_workspace`, `token_revoked`, `token_expired`, `grant_missing`, `grant_revoked`, `grant_expired`,
     `workspace_missing`, `instance_missing`, `user_missing`, `credential_missing`, `credential_mismatch`,
     `malformed_policy`, `not_passthrough`; and the OAuth-only refusals `principal_mismatch`, `oauth_mismatch`,
     `client_revoked` and the grant ending within a minute.
   - **recoverable:** `workspace_disabled`, `instance_disabled`, `user_disabled`, `credential_revoked`,
     `credential_unvalidated`, `no_projects`, `no_tools`.

   A new reason does not compile until it is classified. When in doubt it is final (fail closed).
2. A **final** refusal at an issuance keeps ending the device at once, as before (`invalid_grant`, `oauth.token.refused`
   with `revoked: true`).
3. A **recoverable** refusal answers `503 temporarily_unavailable` with `Retry-After: 60` and keeps the device: nothing is
   revoked, the refresh token is not rotated, and an `oauth.token.refused` row is written with the reason and
   `revoked: false`. A repeat inside the reuse window is held the same way (no successor is returned while it holds).
4. A recoverable refusal at a **code exchange** still spends the code (it is single use and its marker is taken before the
   decision): the same code later is a replay, which ends the unredeemed approval. Nothing else of the person's ends.
5. Per request nothing changes: every MCP request re-runs the same decision, so an access token (including one issued
   before the reason began) is refused with the one `401`, no upstream call and no data, for every reason (final or not),
   for as long as the reason holds. Disabling a person or workspace stops access within the access-cache lifetime, as before.

## Consequences

- A fix (workspace back on, person re-enabled, a credential replaced) does not cost every connected app its approval.
- A client sees `503` and `Retry-After` instead of `invalid_grant`, which RFC 6749 §5.2 reserves for grants that can never
  work; MCP clients that treat a `5xx` at refresh as transient keep their tokens and try again.
- A kept device is not a standing approval beyond what it was: its refresh token still expires (30 days), the grant's own
  expiry still applies, and the 25-device cap still counts it. Idle expiry is a separate task (P5-14).
- The 503 is not a `4xx`, so it does not count toward the token-failure abuse limits; it still costs one decision read.

## Alternatives considered

- **(a) Every refusal ends the device (ADR-0009 as built):** simplest, but a maintenance window costs every app its approval.
- **(c) Never end the device on a refusal:** a revoked grant or a deleted person would leave dead devices that only expire;
  final reasons are exactly the ones where the approval is over.
