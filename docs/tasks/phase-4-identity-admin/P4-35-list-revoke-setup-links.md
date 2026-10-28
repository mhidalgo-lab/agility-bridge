---
id: P4-35
title: List and revoke unused owner setup links (if D-56 chooses it)
phase: 4
status: dropped
priority: low
depends_on: [P4-09]
adr: ["0009"]
lessons: [L-065, L-085, L-093]
owner: ""
---

# P4-35 — List and revoke unused owner setup links (if D-56 chooses it)

> **Dropped 2026-10-28:** D-56 chose (a): setup links are rare and expire in an hour. Reopen before links are issued routinely or the 7-day maximum is used.

> Found by the Phase 4 admin security review (P4-09, decision D-56). Not started.

## Goal
An owner who issued a setup link in the wrong place can cancel it, and can see which links are outstanding.

## Scope
- Storage: list live `setup:` keys with their expiry and (new) the issuing user id; delete one by its id (the hash prefix the
  create call already returns).
- Admin API `GET /setup-links` and `DELETE /setup-links/{id}` (owner, recent sign-in for the delete; the break-glass token
  counts), CLI `setup-link list|revoke`, and a panel section on the users page; audit rows `setup_link.revoke`.
- Never show the code or its full hash.

## Acceptance criteria
- [ ] A revoked link cannot start or finish a sign-in (the setup page and the callback both refuse it); a link used up or
      expired is not listed.
- [ ] Non-owners get `403` on both routes with no listing; a refusal changes nothing (negative tests, mutation-checked).
- [ ] Audit rows say which link (id) and who revoked it.

## Security notes
THREAT_MODEL T14, L-085 (the code stays in the fragment and the body).

## Lessons applied
- L-065, L-085, L-093.

## Docs to update
- Admin access guide, CLI reference (generated), admin API reference (generated), THREAT_MODEL T14.

## Out of scope
- Changing the lifetime limits (1 minute to 7 days).
