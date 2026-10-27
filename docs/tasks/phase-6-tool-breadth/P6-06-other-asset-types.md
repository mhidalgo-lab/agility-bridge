---
id: P6-06
title: Requests, issues, goals, themes and retrospectives through the generic tools
phase: 6
status: in-progress
priority: medium
depends_on: [P2-17]
adr: ["0012"]
lessons: [L-035, L-155, L-153, L-288]
owner: ""
---

# P6-06 — Requests, issues, goals, themes and retrospectives through the generic tools

## Goal
Make issues, requests, goals, themes and retrospectives first-class without growing the catalogue: an agent that asks
about one of them finds a recipe, gets sensible default fields and never has to guess attribute names. No new typed tool
(L-155); a typed tool is added only when usage shows the generic route is not enough (recorded as a decision).

## Scope
- **Recipe resources** (P6-09 manifest, `packages/core/src/recipes/other-assets.ts`): one markdown recipe per type family
  (issues, requests, goals and themes, retrospectives) with example `query_assets` / `get_assets` inputs, served with the
  tools they use and offered only when those tools are allowed (L-290). Static text, no instance words (THREAT_MODEL A12).
- **Default field tiers**: computed from metadata as before; types whose owner relation is the singular `Owner` (issues)
  get `Owner.Name` in the default tier. Tiers per type are tested against the committed snapshot.
- **Synthetic snapshot**: add `RequestStatus` (L-288: a listed Request must be describable) and `Retrospective`
  (hand-written, product attributes checked with `pnpm metadata:drift`); the scope strategy of each type is tested.
- **Live verification** (guarded suite only): each type through `query_assets` and `get_assets` with default tiers;
  absent types recorded as a gap and a follow-up task for the writable sandbox.

## Acceptance criteria
- [ ] Recipe resources for issues, requests, goals/themes and retrospectives are listed and readable only when their tools
      are allowed; every example query in them compiles against the committed snapshot through the real query compiler.
- [ ] Default tiers of Issue, Request, Goal, Theme and Retrospective are tested (identity in minimal, status/owner in
      default) and every tier path resolves.
- [ ] The snapshot describes `RequestStatus` and `Retrospective`; `describe_asset_type` works for all five types offline;
      a denied type is refused with no upstream call.
- [ ] Each type present on the read-only tenant answers `query_assets` and `get_assets` with default tiers in the guarded
      live suite; absent types are recorded as a gap with a follow-up task.
- [ ] `docs/reference/tool-catalogue.md`, `docs/reference/resources.md`, `docs/RESEARCH.md` updated; decisions and
      lessons recorded.

## Security notes
Recipes are static and carry no instance data. Every example value is a bound parameter in the real compiler; the
workspace project restriction and type deny list apply unchanged (negative tests reuse the resource suite's).

## Lessons applied
- L-035 — Validate at the domain level before calling upstream.
- L-155 — Keep the tool count small.
- L-153 — One manifest for resources.
- L-288 — A listed entry must be readable: the fixture needs the status list.

## Docs to update
- docs/reference/tool-catalogue.md
- docs/reference/resources.md (generated)
- docs/RESEARCH.md, docs/dev/verification.md

## Out of scope
- Typed tools for these types (decided against by default; see the phase-6 decisions).
- Writing to any of these types (Phase 7).
