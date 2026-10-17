# ADR-0007 — Envelope encryption of Agility access tokens

- **Status:** proposed
- **Date:** 2026-10-16
- **Related:** P2-03, P3-08, L-074, L-075, L-076, THREAT_MODEL T7

## Context

Agility access tokens do not expire unless revoked and carry the full role and project memberships of the member who
created them. A leaked database or backup must not leak usable tokens.

## Decision

- Tokens are encrypted with **AES-256-GCM** (WebCrypto on both runtimes): fresh 96-bit IV per encryption, 128-bit tag,
  AAD = `credential id | key version`. Ciphertext, IV and key version are stored; plaintext never is.
- Data keys are derived from a **master key** with HKDF-SHA-256 and purpose labels (credentials, key-check values, audit
  identity hashes, cache ids, approval records, task records).
- Master key format: 32 random bytes, `v<N>:<base64>` (bare base64 = version 1). Sources: `AB_MASTER_KEY`,
  `AB_MASTER_KEY_FILE` (refused if group/world readable), OS keychain reference (stdio/Node), Worker secret. Never stored
  beside the database; `init` writes it to the user config directory, not the data directory.
- **Key-check values** detect a wrong master key at boot; a version can never be reused for different material.
- **Rotation**: current + previous key loaded, rows re-encrypted with per-row compare-and-swap in resumable batches,
  then the previous version retired; audit records id, version and reason, never key material.
- Only a short hint (last 4 characters) of a token is ever shown after creation.

## Consequences

- A process holding the master key can decrypt every stored token: protect the host and the secret store; document
  rotation of the Agility tokens themselves after a suspected database leak.
- Lost master key = all stored tokens must be re-entered (documented recovery).

## Alternatives considered

- **Plaintext with file permissions:** rejected.
- **External KMS/HSM integration:** out of scope for 1.0 (documented as a future extension point).
