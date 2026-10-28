---
id: P4-34
title: Make adding an instance an owner-only action (if D-55 chooses it)
phase: 4
status: dropped
priority: low
depends_on: [P4-09]
adr: ["0008"]
lessons: [L-065, L-093, L-235]
owner: ""
---

# P4-34 — Make adding an instance an owner-only action (if D-55 chooses it)

> **Dropped 2026-10-28:** D-55 chose (a): administrators are trusted as much as owners. Reopen if D-55 changes to (b).

> Found by the Phase 4 admin security review (P4-09, decision D-55). Not started: it contradicts a sentence of ADR-0008
> ("an Agility base URL defined by an owner or admin"), so it needs the owner's answer and an ADR that supersedes it.

## Goal
Close the last way an administrator can choose where members' personal Agility tokens are sent: adding an instance at a new
origin. After this, only an owner with a recent sign-in adds an instance, like changing its origin.

## Scope
- A new ADR (superseding that sentence of ADR-0008) once the owner picks option (b) of D-55.
- `guardedServices(...).instances.create`: owner, recent sign-in (the break-glass token is exempt), for every route.
- Panel: the *Add instance* page and button for owners only; the workspace form's "no instance yet" text for admins says to ask
  an owner.
- Role matrix row `Add an instance` becomes `no | no | recent`; `docs/guide/admin-guide.md`, `docs/guide/admin-access.md`,
  THREAT_MODEL A14.

## Acceptance criteria
- [ ] An admin gets `403` on `POST /instances`, with and without `tls`; an owner needs a recent sign-in; nothing is created on
      a refusal (negative test through the API and the panel, mutation-checked).
- [ ] The role-matrix test and the guides agree; the panel shows the control exactly where the API allows it.

## Security notes
THREAT_MODEL A14 (rogue administrator), T14.

## Lessons applied
- L-065, L-093, L-235.

## Docs to update
- ADR (new), admin guide, admin access guide, THREAT_MODEL.

## Out of scope
- Changing an existing instance's origin (already owner only).
