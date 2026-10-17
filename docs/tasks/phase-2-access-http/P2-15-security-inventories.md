---
id: P2-15
title: Security inventories (cryptography, logging, data protection)
phase: 2
status: todo
priority: medium
depends_on: [P2-03, P2-08]
adr: ["0007"]
lessons: [L-120, L-010]
owner: ""
---

# P2-15 — Security inventories (cryptography, logging, data protection)

## Goal
Living inventories that reviewers and auditors can check against the code.

## Scope
- `docs/security/cryptography.md`: every key, algorithm, derivation label, random source, rotation procedure.
- `docs/security/logging.md`: every sink, field, redaction rule, retention, reader.
- `docs/security/data-protection.md`: personal data stored, retention, deletion, export, what goes to the LLM.

## Acceptance criteria
- [ ] Each inventory entry links to the code and test that implement it; every key and algorithm from P2-03 and every sink and field from P2-08 is covered.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-120 — Keep security inventories from the first storage task.
- L-010 — Every security claim needs evidence.

## Docs to update
- docs/security/*.md (new)

## Out of scope
- Anything not listed under Scope.
