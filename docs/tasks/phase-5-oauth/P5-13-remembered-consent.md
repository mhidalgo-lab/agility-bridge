---
id: P5-13
title: Remembered read consent (opt-in)
phase: 5
status: todo
priority: low
depends_on: [P5-04, P5-05]
adr: ["0009"]
lessons: [L-090, L-247, L-248]
owner: ""
---

# P5-13 — Remembered read consent (opt-in)

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7). Created by P5-04,
> which deliberately shows the consent page on every authorization ([D-66](../../pending-decisions/phase-5.md)).

## Goal
A person who reconnects the same app often can choose not to be asked again, without giving any web page the power to issue
codes or end devices.

## Scope
- An unticked "don't ask again for this app" box (30 days, capped per person), stored server-side per user + client +
  redirect URI + workspace, written only after an explicit approval with the box ticked, never for write scopes
  (Phase 7), never for a request whose scopes exceed what was approved.
- A remembered approval still goes through `approve()` (grant live, access resolved) and a code is issued only for a
  top-level navigation; it never replaces a device (L-090, L-247: replacement waits for the code exchange).
- A list of remembered apps on My access with **Forget**; disconnecting a device forgets its approval.
- Decide first (D-66) whether real clients (P5-06 matrix) are too chatty without it.

## Acceptance criteria
- [ ] The decision is recorded; if built, a silent navigation with a remembered approval issues a code but ends nothing,
  and every refusal of the consent suite still holds.
- [ ] Forget and disconnect remove the approval; a forgotten app asks again.

## Security notes
THREAT_MODEL T9, T10 (a standing approval for an unverified client is the risk; relic-bridge Phase 5 review H1).

## Lessons applied
- L-090, L-247 — nothing replaces or revokes on a request alone.
- L-248 — the page's handle still binds every explicit approval.

## Docs to update
- docs/dev/oauth.md, docs/guide/oauth-phone.md, docs/THREAT_MODEL.md

## Out of scope
- `mcp:write` consent (Phase 7).
