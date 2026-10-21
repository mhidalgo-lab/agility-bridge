---
id: P2-03
title: Secrets encryption and master-key rotation
phase: 2
status: done
priority: high
depends_on: [P2-01]
adr: ["0007"]
lessons: [L-074, L-075, L-076, L-120]
owner: "Matias Hidalgo"
---

# P2-03 — Secrets encryption and master-key rotation

## Goal
Agility access tokens are never stored in plain text, and the master key can be rotated safely.

## Scope
- AES-256-GCM envelope encryption with AAD `credential id | key version`; HKDF-SHA-256 purpose keys; key-check values.
- Master key `v<N>:<base64>` from `AB_MASTER_KEY`, `AB_MASTER_KEY_FILE` (refused if group/world readable) or the keychain later (P8-08); never beside the database; `init` writes it to the user configuration directory.
- Rotation with current + previous keys, per-row compare-and-swap, resumable batches, retirement of the previous version; audit without key material.

## Acceptance criteria
- [x] Round-trip, wrong-key, tampered-ciphertext and wrong-AAD tests. *(Also tampered IV, another version label,
  another purpose, an unloaded version; mutation-checked: dropping the record id from the additional data fails them.)*
- [x] Rotation interrupted and resumed in tests; a reused version for different material is refused. *(Plus a row
  changed during the rotation is skipped, not overwritten, and picked up by the next run.)*

## Notes
- `packages/auth/src/secrets/`: master-key parsing and generation, `Keyring` (HKDF-SHA-256 purpose keys, AES-256-GCM,
  HMAC-SHA-256), credential sealing, key-check values at boot (`verifyKeyring`), `rotateCredentialKeys`,
  `retireKeyVersion`, `keyStatus`. Storage gained `credentials.replaceSecret` (compare-and-swap) and a key-version
  filter, in the contract suite.
- `apps/cli/src/master-key.ts`: `AB_MASTER_KEY` / `AB_MASTER_KEY_FILE` (+ `AB_MASTER_KEY_PREVIOUS` /
  `AB_MASTER_KEY_FILE_PREVIOUS`), key files refused when readable by others, symbolic links or inside the data
  directory; `createMasterKeyFile` for `init`. Not reachable from the CLI entry yet (the published bundle is
  unchanged): `serve` (P2-06) loads the keys, and P2-10 adds the `init` and `keys status|rotate|retire` commands the
  guide documents.

## Security notes
THREAT_MODEL T7.

## Lessons applied
- L-074 — Keep the master key away from the data.
- L-075 — Envelope encryption done properly.
- L-076 — Handle files defensively.
- L-120 — Keep security inventories from the first storage task.

## Docs to update
- [x] docs/security/cryptography.md (started here, completed in P2-15)
- [x] docs/guide/secrets.md (new)

## Out of scope
- Anything not listed under Scope.
