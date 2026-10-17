---
id: P2-03
title: Secrets encryption and master-key rotation
phase: 2
status: todo
priority: high
depends_on: [P2-01]
adr: ["0007"]
lessons: [L-074, L-075, L-076, L-120]
owner: ""
---

# P2-03 — Secrets encryption and master-key rotation

## Goal
Agility access tokens are never stored in plain text, and the master key can be rotated safely.

## Scope
- AES-256-GCM envelope encryption with AAD `credential id | key version`; HKDF-SHA-256 purpose keys; key-check values.
- Master key `v<N>:<base64>` from `AB_MASTER_KEY`, `AB_MASTER_KEY_FILE` (refused if group/world readable) or the keychain later (P8-08); never beside the database; `init` writes it to the user configuration directory.
- Rotation with current + previous keys, per-row compare-and-swap, resumable batches, retirement of the previous version; audit without key material.

## Acceptance criteria
- [ ] Round-trip, wrong-key, tampered-ciphertext and wrong-AAD tests.
- [ ] Rotation interrupted and resumed in tests; a reused version for different material is refused.

## Security notes
THREAT_MODEL T7.

## Lessons applied
- L-074 — Keep the master key away from the data.
- L-075 — Envelope encryption done properly.
- L-076 — Handle files defensively.
- L-120 — Keep security inventories from the first storage task.

## Docs to update
- docs/security/cryptography.md (P2-15)
- docs/guide/secrets.md (new)

## Out of scope
- Anything not listed under Scope.
