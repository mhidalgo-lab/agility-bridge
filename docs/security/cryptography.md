# Cryptography inventory

> Every algorithm, key and random value agility-bridge uses, where it lives and how it is rotated (L-120). Updated in
> the same PR as any change; reviewed at every phase review and in P9-01. Started in P2-03; completed with the
> logging and data-protection inventories in P2-15.

All cryptography is **WebCrypto** (`crypto.subtle`, `crypto.getRandomValues`), identical on Node and Workers; no
third-party cryptographic code.

## Keys and derived keys

| Key | Source | Algorithm | Used for | Stored | Rotation |
|---|---|---|---|---|---|
| Master key `v<N>` | 32 bytes from `crypto.getRandomValues` (`agility-bridge init`) | HKDF-SHA-256 input key material, imported non-extractable | Deriving the purpose keys below | Never by agility-bridge: `AB_MASTER_KEY` / `AB_MASTER_KEY_FILE` (`0600`, not a symbolic link, outside the data directory), a Worker secret later | New version + `keys rotate`, then `keys retire` ([secrets guide](../guide/secrets.md)) |
| Credential key | HKDF-SHA-256(master, salt `agility-bridge/hkdf/v1`, info `agility-bridge/credentials/v<N>`) | AES-256-GCM, 96-bit random IV per encryption, 128-bit tag, additional data `credential id \| key version` | Agility access tokens of credentials | Only as ciphertext + IV + version in `credentials` | With the master key (per-row compare-and-swap) |
| Key-check key | HKDF, info `agility-bridge/key-check/v<N>` | HMAC-SHA-256 over a fixed label | Detecting a wrong master key, refusing reuse of a version for other material | The value in `kv` `crypto:kcv:v<N>` (never deleted) | — |
| Audit identity key | HKDF, info `agility-bridge/audit-identity/v<N>` | HMAC-SHA-256 | Keyed fingerprints of identities in the audit log (pass-through tokens, P2-14) | — | With the master key |
| Cache id key | HKDF, info `agility-bridge/cache-id/v<N>` | HMAC-SHA-256 | Cache entry ids (P8-01) | — | With the master key |
| Approval key | HKDF, info `agility-bridge/approval/v<N>` | AES-256-GCM | Write approval records (P7-01) | — | With the master key |
| Task key | HKDF, info `agility-bridge/task/v<N>` | AES-256-GCM | Task records (P8-10) | — | With the master key |

Purpose keys are derived per process on first use and kept as non-extractable `CryptoKey`s; they are never logged,
returned or stored. A key derived for one purpose cannot open another purpose's data (tested).

## Hashes and comparisons

| Value | Algorithm | Notes |
|---|---|---|
| Migration checksums | SHA-256 over version, name and statements | Integrity of the schema history, not a secret (P2-01) |
| Device tokens at rest | SHA-256 (P2-05) | 256-bit random tokens, so an unsalted hash is sufficient |
| Key-check values, admin token | constant-time comparison (`timingSafeEqual`) | |

## Random values

| Value | Source | Size |
|---|---|---|
| Master key | `crypto.getRandomValues` | 256 bits |
| AES-GCM IVs | `crypto.getRandomValues` | 96 bits, fresh per encryption |
| Audit and request ids | `crypto.randomUUID` | 122 bits |
| Untrusted-data envelope markers | `crypto.randomUUID` (P1-05) | 122 bits |

## Failure handling

- A wrong master key, a reused version number or a retired current version stop the server at start.
- Decryption failures (wrong key, tampering, a ciphertext moved to another credential or version) raise
  `decrypt_failed`; credentials on a version that is not loaded raise `key_unavailable` and are reported at start.
- Error messages never contain key material, ciphertext or plaintext, including for malformed keys.
