---
id: P6-11
title: Cost accounting and composite grants
phase: 6
status: review
priority: medium
depends_on: [P6-07]
adr: ["0010"]
lessons: [L-037, L-114, L-115]
owner: ""
---

# P6-11 — Cost accounting and composite grants

## Goal
Every tool's declared cost is honest, a tool that cannot fit the per-call budget is not offered, and an operator is told
when a composite is granted without the sibling tools it reads.

## Scope
- One test over `CORE_TOOLS` with a worst-case fixture per tool (a registry in `packages/core/test/tools/worst-case.ts`);
  a tool without a fixture fails the test, so adding a tool means adding its worst case. It measures a cold call and asserts
  requests <= declared cost.
- A check that L-115 holds for every tool, composites (costs 20-54) included: `select({ maxCost })` hides what cannot fit
  and a composite is never listed with a sibling it would need hidden by budget without a warning.
- Sibling metadata: one table (`COMPOSITE_SIBLINGS`, `packages/core/src/tools/reports/siblings.ts`) names the tools each
  composite reads; `compositeWarnings(granted)` returns one warning per granted composite missing some of them. A test ties
  the table to what each report really runs.
- Surfaces: `whoami` (structured `warnings` and a note, only when there are any; the output schema is open, so `tools/list`
  does not grow), the admin API `/tools` (`siblings`), and the panel: workspace detail, grant detail (notes). Escaping and
  negative tests for the panel.

## Acceptance criteria
- [x] A single test iterates `CORE_TOOLS` and fails for a tool with no worst-case fixture or a measured cold cost above its
  declared cost.
- [x] `select({ maxCost })` is tested over the real catalogue: no listed tool costs more than the budget, composites included.
- [x] `COMPOSITE_SIBLINGS` is the single source: every report is covered by a test that its sections run exactly those tools.
- [x] `whoami` shows the warning (structured and note) for a composite granted without a sibling, nothing otherwise.
- [x] The workspace and grant pages show the warning; names are escaped; a workspace on "all tools" and a complete list show none.
- [x] `docs/dev/tool-conventions.md`, generated references, a changeset.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-037 — Composite tools need their own authorization and cost model.
- L-114 — Declared costs cover the worst case.
- L-115 — Hide what cannot fit.

## Docs to update
- docs/dev/tool-conventions.md

## Out of scope
- Anything not listed under Scope.
