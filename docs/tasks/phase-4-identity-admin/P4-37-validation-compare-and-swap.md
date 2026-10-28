---
id: P4-37
title: Record a credential validation only while the sealed token is the one that was checked
phase: 4
status: done
priority: low
depends_on: [P4-09]
adr: ["0007"]
lessons: [L-065, L-239]
owner: ""
---

# P4-37 — Record a credential validation only while the sealed token is the one that was checked

> Found by the Phase 4 admin security review (P4-09, L-239). P4-09 drops a validation answer when the sealed token changed
> while Agility was answering; between that look and the write a few milliseconds remain.

## Goal
Close the last window with a compare-and-swap in storage, so a validation result can never be recorded against a token it was
not about.

## Scope
- `CredentialRepository.recordValidation(id, expected: SealedToken, patch)`: one conditional `UPDATE ... WHERE id = ? AND
  token_ciphertext = ? AND token_iv = ? AND key_version = ?`; `false` when it did not apply. Memory, SQLite and D1.
- `validateCredential` uses it instead of the read-then-update added in P4-09, and returns the stored record on `false`.

## Acceptance criteria
- [x] A contract test on every adapter: a replacement between read and record leaves the validation fields untouched.
- [x] The P4-09 regression test (late answer for the old token) still passes and fails when the swap is reverted.

## Security notes
THREAT_MODEL T14, A5 (a credential is used only after its own validation).

## Lessons applied
- L-065, L-239.

## Docs to update
- Storage guide (dev).

## Out of scope
- Re-encryption during key rotation (it already uses `replaceSecret`).
