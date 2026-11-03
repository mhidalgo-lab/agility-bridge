---
id: P9-01
title: Threat model final review and evidence map
phase: 9
status: in-progress
priority: high
depends_on: [P8-12]
adr: []
lessons: [L-010, L-123, L-133]
owner: "claude (phase 9 lane A)"
---

# P9-01 — Threat model final review and evidence map

> Refined 2026-11-03 (tasks/README rule 7). Depends on P8-12, waived by the owner on 2026-11-03 (live pass pending):
> evidence that needs a live tenant is marked as such, never faked.

## Goal
Every threat-model claim is backed by code, a test or a named residual risk, and that stays true because a test reads it.

## Scope
- A map of every `T1`-`T35` and `A1`-`A15` row to code paths and test files and titles, in `docs/security/threat-evidence.md`,
  with a level (`A` automated, `A+L` automated plus a live or real-client part, `P` process) per row.
- A test that reads the map (`scripts/test/threat-evidence.test.ts`).
- Fuzz and property tests for every parser that takes text across a trust boundary and has none yet (first list what
  is already fuzzed; seeded and replayable like `harness/property.ts`).
- The accepted residual risks as one register, and the live-only evidence as another, both in the map.
- A final-review section in `THREAT_MODEL.md` and the header status.

## Acceptance criteria
- [ ] Every `T`/`A` row of `THREAT_MODEL.md` has exactly one row in the evidence map with code paths, test files and
      quoted test titles, and a test fails when a row, a path or a title is missing.
- [ ] Parsers without fuzz coverage get properties stated on the output (not lists of bad inputs): rich text,
      redaction, instance URLs and address classes, asset references, XML, CSV, cursors, token formats, bearer header,
      sealed values, JWT wrapper, instance metadata, OAuth client ids/redirects/registrations, MCP bodies, config bundle.
      Any counter-example found becomes a fix with a regression test (or a task).
- [ ] Accepted residual risks are explicit (register with reason, rows, where documented) and the owner decision is
      recorded (D-346).
- [ ] Rows whose evidence needs a live tenant or a real client are marked `A+L` and name what is unproven (register
      L-n); none is claimed as verified.
- [ ] `THREAT_MODEL.md` has the final-review section and its status line; new lessons recorded.
- [ ] `pnpm lint && pnpm typecheck && pnpm test` green.

## Security notes
No behaviour change is expected; a fuzz counter-example would be a security fix and follows AGENTS.md.

## Lessons applied
- L-010 — Every security claim needs evidence.
- L-123 — Seeded, replayable property tests.
- L-133 — Executable documentation.

## Docs to update
- docs/THREAT_MODEL.md
- docs/security/threat-evidence.md (new)

## Out of scope
- The external review (P9-02) and ASVS/OpenSSF mapping (P9-06).
