# ADR-0017 — OAuth secrets at rest: token-bound keys instead of the master key

- **Status:** accepted (owner, 2026-10-26, D-62 and D-70)
- **Date:** 2026-10-26
- **Supersedes:** the "Secrets at rest" sentence of [ADR-0009](0009-authentication.md) §3, for grant properties and the
  refresh-reuse successor only
- **Related:** P5-01, P5-05, [D-62](../pending-decisions/phase-5.md), [D-70](../pending-decisions/phase-5.md), L-074,
  L-164, L-253 – L-255, THREAT_MODEL T9, T15

## Context

ADR-0009 says that grant properties and any recoverable transient secret, including the refresh-reuse successor, are
"envelope-encrypted". In this project that phrase means the keyring under the master key (ADR-0007). The OAuth
runtime built in Phase 5 holds no keyring: on the Worker, reading the master key on every token request would cost one
more secret read per refresh, and a master-key rotation would have to rewrite live OAuth rows.

Two things in OAuth storage must be recoverable rather than hash-only:

- **Grant properties** (workspace, access grant, user and client ids). `@cloudflare/workers-oauth-provider` 1.2.3
  encrypts them under a key that is itself wrapped under each token issued for the grant.
- **The refresh-reuse successor** (P5-05). For up to 120 s after a refresh, a repeat of the spent refresh token gets
  the same new access and refresh tokens, so they must be stored and recoverable for that window.

## Decision

1. Grant properties use the provider's scheme: encrypted under a key wrapped under each token. No new `KeyPurpose`
   (D-62).
2. The refresh-reuse successor is sealed with AES-256-GCM under a key derived with HKDF-SHA-256 from the spent refresh
   token, and bound to that token's hash. The sealed row lives for the reuse window only. The rotation marker (a hash
   and a time) lives for the refresh lifetime so that a late replay is recognised and revokes the device (D-70).
3. Everything else in ADR-0009 §3 stands. Authorization codes, access tokens and refresh tokens are stored hash-only,
   and storage scans in the tests prove that no bearer value is stored in plaintext.

## Consequences

- A stolen database or backup opens neither grant properties nor sealed successors, even together with the master
  key, because the opening key exists only in tokens the server never stores.
- No key is stored, rotated or lost for these rows, so L-074's master-key rules hold trivially, and a master-key
  rotation does not touch OAuth storage.
- Someone holding a spent refresh token inside the reuse window can recover its successor. The window allows that by
  design (concurrent refreshes, L-029), and a repeat after the window revokes the device.
- If the server loses every token of a grant, its properties can no longer be read. The grant is then useless anyway,
  and it expires.

## Alternatives considered

- **A keyring purpose under the master key:** the database plus the master key would open every sealed row, the
  runtime would need the keyring, and rotation would have to rewrite or drop live rows. Rejected as weaker and costlier.
- **Successor stored in plaintext for the window:** rejected; ADR-0009 forbids recoverable secrets in plaintext.
