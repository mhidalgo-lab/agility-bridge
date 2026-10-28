---
id: P6-44
title: Cut the core test suite's runtime
phase: 6
status: done
priority: low
depends_on: [P6-13]
adr: []
lessons: [L-124, L-322]
owner: ""
---

# P6-44 — Cut the core test suite's runtime

## Goal
The core suite grew from 33 s to 59 s wall with Phase 6 (about 2x per file), almost all import and per-file world setup; slow runs raise the chance of timing flakes. (Found by the Phase 6 review, [P6-13](P6-13-phase-6-review.md).)

## Scope
- Try `isolate: false` for `packages/core` (the repository bans module-level request state); share one primed `MetadataService` per file for tests that are not about cold cost; create the MCP handler once per file in `rpc` and silence the `responseMode` warning; fold the many tiny report cases that share a world into table tests; share the prebuilt worlds of `consistency.test.ts` and `resources.test.ts`.

## Outcome
`isolate: false` alone gave the saving (import and per-file world setup were the cost), so the other measures in Scope (a shared primed `MetadataService`, one handler per file, table tests, shared worlds) were not needed and were not built: each would trade test independence for little time. Revisit only if the suite grows again.

## Acceptance criteria
- [x] Core wall time falls by a third or more with no test removed (65 s to 21 s wall, 939 tests before and after, 3-core machine, `isolate: false`).
- [x] No test depends on state left by another (shuffled files and tests, seeds 1 and 2, all 939 pass).

## Security notes
None beyond the shared rules in AGENTS.md; a change to what is read or logged updates THREAT_MODEL in the same PR.

## Lessons applied
- L-124
- L-322

## Docs to update
- The pages of the tools and files touched; docs/reference generated pages.

## Out of scope
- Anything not listed under Scope.
