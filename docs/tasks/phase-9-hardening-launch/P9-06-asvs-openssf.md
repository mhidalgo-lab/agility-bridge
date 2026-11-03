---
id: P9-06
title: ASVS L2 mapping and OpenSSF Best Practices
phase: 9
status: in-progress
priority: medium
depends_on: [P9-01]
adr: []
lessons: [L-010, L-120, L-483]
owner: "claude (phase 9 lane A)"
---

# P9-06 — ASVS L2 mapping and OpenSSF Best Practices

> Refined 2026-11-03 (tasks/README rule 7). Depends on P8-12 only through P9-01, waived by the owner on 2026-11-03 (live
> pass pending). Registering the badge and any external assessment are owner steps.

## Goal
Show the security posture with recognised checklists, with evidence that CI keeps true.

## Scope
- OWASP ASVS **5.0.0** Level 1 and 2 (253 requirements, from the official CSV of the `v5.0.0` release): one row per
  requirement with a status (Met, Partly, Delegated, N/A with a reason, Gap) and evidence links, in
  `docs/security/asvs-l2.md`, plus a test that checks it.
- OpenSSF Best Practices **passing** level (67 criteria): the exact status and justification to paste for each, in
  `docs/security/best-practices-answers.md`.
- OpenSSF Scorecard: triage every check below 10 (public result, code-scanning alerts) and fix the quick wins; anything
  that needs a ruleset change or a second person is a decision, not an edit (repository rulesets are the owner's).
- Source facts and fetch dates in `docs/RESEARCH.md`.
- A task for the ASVS rows that are only partly met.

## Acceptance criteria
- [x] Every ASVS 5.0.0 Level 1 and 2 requirement has exactly one row with a status and evidence or a reason; a test
      checks the count, the statuses and that every linked file exists; no row is `Gap` without a task.
- [x] Quick wins found while mapping are fixed with a test (V13.4 exposure test).
- [x] The OpenSSF passing criteria each have an answer and a justification with a URL; claims only the owner can make
      are marked `*owner:*`.
- [x] Scorecard findings are triaged in `docs/security/scorecard.md` (cause, fix or decision, owner action).
- [x] RESEARCH.md records the ASVS and OpenSSF sources with URLs and dates; lessons and decisions recorded.
- [x] `pnpm lint && pnpm typecheck && pnpm test` green.
- [ ] *owner:* The Best Practices badge is registered on bestpractices.dev with these answers and shown in the README.

## Security notes
No behaviour change; the mapping states only what the repository can show.

## Lessons applied
- L-010 — Every security claim needs evidence.
- L-120 — Keep security inventories from the first storage task.
- L-483 — Evidence maps are read by a test.

## Docs to update
- docs/security/asvs-l2.md (new)
- docs/security/best-practices-answers.md (new)
- docs/security/scorecard.md (new)
- docs/RESEARCH.md

## Out of scope
- ASVS Level 3; an external assessment (P9-02).
