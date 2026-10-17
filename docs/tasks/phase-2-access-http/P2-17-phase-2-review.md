---
id: P2-17
title: Phase 2 review and live verification
phase: 2
status: todo
priority: high
depends_on: [P2-02, P2-07, P2-10, P2-12, P2-13, P2-14, P2-15, P2-16]
adr: []
lessons: [L-004, L-010, L-065, L-121]
owner: ""
---

# P2-17 — Phase 2 review and live verification

## Goal
Adversarial review of storage, encryption, access model and HTTP before going to the edge.

## Scope
- Review every alternate writer of credentials, defaults, Agility projects and tools.
- Live checks with VS Code, JetBrains, Copilot CLI, Claude Code and Cursor over HTTP with device tokens.
- Threat-model statuses with evidence; findings → tasks.

## Acceptance criteria
- [ ] `docs/reviews/phase-2-review.md`; client matrix updated; go for Phase 3.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-004 — End every phase with a review and a live pass, and reserve capacity for follow-ups.
- L-010 — Every security claim needs evidence.
- L-065 — Every alternate writer is an authorization boundary.
- L-121 — Negative authorization is first-class.

## Docs to update
- docs/reviews/phase-2-review.md (new)
- docs/THREAT_MODEL.md

## Out of scope
- Anything not listed under Scope.
