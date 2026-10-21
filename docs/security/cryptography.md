# Cryptography inventory

> Every algorithm, key and random value agility-bridge uses, where it is implemented and tested, and how it is rotated
> (L-120, L-010). Updated in the same PR as any change; reviewed at every phase review and in P9-01.
> `scripts/test/security-inventories.test.ts` fails when a key purpose is missing here or a link breaks.

All cryptography is **WebCrypto** (`crypto.subtle`, `crypto.getRandomValues`, `crypto.randomUUID`), identical on Node
and Workers; no third-party cryptographic code.

## Keys and derived keys

| Key | Source | Algorithm | Used for | Stored | Rotation | Code · tests |
|---|---|---|---|---|---|---|
| Master key `v<N>` | 32 bytes from `crypto.getRandomValues` (`agility-bridge init`) | HKDF-SHA-256 input key material, imported non-extractable | Deriving the purpose keys below | Never by agility-bridge: `AB_MASTER_KEY` / `AB_MASTER_KEY_FILE` (`0600`, not a symbolic link, outside the data directory); a Worker secret later | New version + `keys rotate`, then `keys retire` ([secrets guide](../guide/secrets.md)) | [keyring.ts](../../packages/auth/src/secrets/keyring.ts), [master-key.ts](../../apps/cli/src/master-key.ts) · [secrets.test.ts](../../packages/auth/test/secrets.test.ts), [master-key.test.ts](../../apps/cli/test/master-key.test.ts) |
| `credentials` | HKDF-SHA-256(master, salt `agility-bridge/hkdf/v1`, info `agility-bridge/credentials/v<N>`) | AES-256-GCM, 96-bit random IV per encryption, 128-bit tag, additional data `credential id \| key version` | Agility access tokens of credentials | Only ciphertext + IV + version in `credentials` | With the master key (per-row compare-and-swap) | [credentials.ts](../../packages/auth/src/secrets/credentials.ts) · [secrets.test.ts](../../packages/auth/test/secrets.test.ts) |
| `key-check` | HKDF, info `agility-bridge/key-check/v<N>` | HMAC-SHA-256 over a fixed label | Detecting a wrong master key, refusing reuse of a version for other material | The value in `kv` `crypto:kcv:v<N>` (never deleted) | — | [credentials.ts](../../packages/auth/src/secrets/credentials.ts) (`verifyKeyring`) · [secrets.test.ts](../../packages/auth/test/secrets.test.ts) |
| `audit-identity` | HKDF, info `agility-bridge/audit-identity/v<N>` | HMAC-SHA-256 | Keyed fingerprints of identities in the audit log (pass-through tokens, P2-14) | — | With the master key | [keyring.ts](../../packages/auth/src/secrets/keyring.ts) · [secrets.test.ts](../../packages/auth/test/secrets.test.ts) |
| `cache-id` | HKDF, info `agility-bridge/cache-id/v<N>` | HMAC-SHA-256 | Cache entry ids (P8-01) | — | With the master key | [keyring.ts](../../packages/auth/src/secrets/keyring.ts) |
| `approval` | HKDF, info `agility-bridge/approval/v<N>` | AES-256-GCM | Write approval records (P7-01) | — | With the master key | [keyring.ts](../../packages/auth/src/secrets/keyring.ts) |
| `task` | HKDF, info `agility-bridge/task/v<N>` | AES-256-GCM | Task records (P8-10) | — | With the master key | [keyring.ts](../../packages/auth/src/secrets/keyring.ts) |

Purpose keys are derived per process on first use and kept as non-extractable `CryptoKey`s; they are never logged,
returned or stored. A key derived for one purpose cannot open another purpose's data (tested).

## Bearer values

| Value | Format | Entropy | At rest | Checked | Code · tests |
|---|---|---|---|---|---|
| Device token | `ab_live_` / `ab_test_` + 43 base62 + `_` + 6 base62 CRC-32 | 256 bits | SHA-256 (hex) and a display prefix (`ab_live_` + 4 characters) | Format and checksum offline, then hash lookup and constant-time comparison | [device.ts](../../packages/auth/src/tokens/device.ts) · [tokens.test.ts](../../packages/auth/test/tokens.test.ts), [device-token-rule.test.ts](../../scripts/test/device-token-rule.test.ts) |
| Break-glass admin token | `ab_admin_` + 43 base62 + `_` + 6 base62 | 256 bits | Not stored: the operator keeps it (`AB_ADMIN_TOKEN_FILE`); the server holds its SHA-256 in memory | Generated values only (checksum), constant-time comparison | [admin.ts](../../packages/auth/src/tokens/admin.ts) · [admin.test.ts](../../packages/http-app/test/admin.test.ts) |

## Hashes and comparisons

| Value | Algorithm | Notes | Code |
|---|---|---|---|
| Migration checksums | SHA-256 over version, name and statements | Integrity of the schema history, not a secret (P2-01) | [migrate.ts](../../packages/storage/src/sql/migrate.ts) |
| Device and admin tokens | SHA-256 | Unsalted is sufficient for 256-bit random values | [device.ts](../../packages/auth/src/tokens/device.ts) |
| Key-check values, token digests | constant-time comparison (`timingSafeEqual`) | | [keyring.ts](../../packages/auth/src/secrets/keyring.ts) |

## Random values

| Value | Source | Size |
|---|---|---|
| Master key | `crypto.getRandomValues` | 256 bits |
| AES-GCM IVs | `crypto.getRandomValues` | 96 bits, fresh per encryption |
| Device and admin tokens | `crypto.getRandomValues` | 256 bits |
| Record ids, request and audit ids | `crypto.randomUUID` | 122 bits |
| Untrusted-data envelope markers | `crypto.randomUUID` (P1-05) | 122 bits |

## Failure handling

- A wrong master key, a reused version number or a retired current version stop the server at start.
- Decryption failures (wrong key, tampering, a ciphertext moved to another credential or version) raise
  `decrypt_failed`; credentials on a version that is not loaded raise `key_unavailable` and are reported at start.
- Error messages never contain key material, ciphertext or plaintext, including for malformed keys.
