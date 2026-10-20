---
id: P0-02
title: License, community and security policy files
phase: 0
status: review
priority: high
depends_on: [P0-01]
adr: ["0002", "0003"]
lessons: [L-132, L-135]
owner: "Matias Hidalgo"
---

# P0-02 — License, community and security policy files

## Goal
A public-ready repository: license, notice, contribution rules with DCO, a security policy with private reporting and response targets, a code of conduct, templates and the trademark disclaimer.

## Scope
- `LICENSE` (Apache-2.0) and `NOTICE`.
- `CONTRIBUTING.md`: DCO, Conventional Commits, the task workflow, local checks, how to add a lesson.
- `SECURITY.md`: GitHub private vulnerability reporting; acknowledge within 3 business days, assess within 7, fix or mitigate high/critical within 30; dependency advisory targets (critical 7 days, high 14, moderate 30); supported versions (latest minor before 1.0).
- `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1).
- Issue templates (bug, feature, client compatibility report) and a PR template mirroring the definition of done in AGENTS.md.
- Disclaimer and Acceptable Use Policy note (ADR-0002) in the README.

## Acceptance criteria
- [x] All files present and linked from the README.
- [x] `SECURITY.md` names the private reporting channel and the response targets.
- [x] The disclaimer text is identical everywhere it appears (README, npm description draft, docs). *(Enforced by `scripts/test/disclaimer.test.ts` for README, NOTICE, the npm README and ADR-0002.)*
- [x] The PR template checklist matches AGENTS.md (tests incl. negative authorization, docs, threat model, no secrets or real data, changeset, DCO).

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-132 — Harden dependency intake.
- L-135 — README and docs are release artifacts.

## Docs to update
- README.md
- AGENTS.md (links)

## Out of scope
- Documentation site (P9-04)
