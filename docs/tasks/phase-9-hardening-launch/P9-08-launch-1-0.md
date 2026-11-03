---
id: P9-08
title: Launch checklist and 1.0.0
phase: 9
status: in-progress
priority: high
depends_on: [P9-02, P9-03, P9-04, P9-05, P9-06, P9-07]
adr: []
lessons: [L-023, L-135]
owner: "claude (phase 9 lead)"
---

# P9-08 — Launch checklist and 1.0.0

> Refined 2026-11-03 (tasks/README rule 7). Depends on P9-02 to P9-07; started while P9-02, P9-03, P9-04, P9-05 and
> P9-07 still have owner items open (and P8-12 waived), because the checklist is what tracks them. Signing off and
> publishing are owner steps.

## Goal
Ship 1.0 with every gate checked.

## Scope
- One launch checklist, `docs/dev/launch-checklist.md`: scope and freeze, functionality, real-client matrix, security
  evidence, documentation, provenance, rollback, release notes and announcement; each gate ticked with a link to its
  evidence or marked with who closes it (*owner:*, *live:*).
- A draft summary for the top of the 1.0.0 release notes and the exact steps to cut 1.0.0 (a major changeset through the
  normal release flow).
- README links the checklist.

## Acceptance criteria
- [x] `docs/dev/launch-checklist.md` covers every gate of the scope; every ticked item links its evidence; every open
      item names its owner step or task; its links pass `pnpm lint`.
- [x] The rollback per channel (npm, GHCR, Worker, self-hosted) and the steps to cut 1.0.0 are written down.
- [x] README links the checklist; `pnpm lint && pnpm typecheck && pnpm test` green.
- [ ] *owner:* every open checklist item closed or moved out of 1.0 by a decision; checklist signed off.
- [ ] *owner:* v1.0.0 published and verified with the verification guide; README and ROADMAP updated for 1.0.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-023 — SDK conformance does not prove client compatibility.
- L-135 — README and docs are release artifacts.

## Docs to update
- docs/dev/launch-checklist.md (new)
- README.md
- docs/ROADMAP.md

## Out of scope
- Anything not listed under Scope.
