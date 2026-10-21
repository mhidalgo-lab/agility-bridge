---
id: P0-12
title: Agility sandbox and live-verification harness
phase: 0
status: done
priority: high
depends_on: [P0-03, P0-14]
adr: ["0011"]
lessons: [L-003, L-122, L-125]
owner: "Matias Hidalgo"
---

# P0-12 — Agility sandbox and live-verification harness

## Goal
A safe Agility sandbox, a protected way to run live tests and a template for evidence, before any spike or tool depends on real behaviour.

## Decisions
- D-01 (2026-10-19): the only instance is the owner's personal account in a third-party company's hosted tenant, usable
  **strictly read-only**. No seed data is created and nothing in that tenant is modified; a writable sandbox comes
  before Phase 7 (P7-07). No on-premises instance for now (D-13).

## Scope
- Owner confirms that the tenant's company is aware of read-only API testing with the owner's account.
- One member (the owner's account) with a personal access token, stored only as an `AB_LIVE_*` environment secret.
  Reader/writer permission differences are covered by mocks until the writable sandbox exists.
- Inventory instead of a seed plan: which of these exist and are visible to the account (counts and asset types only,
  no content): parent/child Agility projects, teams with their own workflows, sprints, members, backlog items, defects,
  tasks, tests, epics with categories (Feature, Initiative), issues, requests, regression tests/plans/suites, test sets,
  custom fields, conversations, attachments. Gaps are listed for the writable sandbox.
- A read-only guard in the live harness: only `GET` requests and `query.v1`/`meta.v1` reads reach the tenant; any other
  method or endpoint fails the test before it is sent.
- No rate-limit, quota or error-count probing against the third-party tenant (those wait for the writable sandbox).
- GitHub `live` environment restricted to `main`, with required reviewers and `AB_LIVE_*` secrets.
- Live-suite skeleton (`vitest.live.config`): read-only, never on fork PRs, never prints tokens or tenant content.
- `docs/dev/verification.md`: evidence template (date, instance version, workspace, asset numbers, expected vs actual,
  redactions; shapes and counts only for the third-party tenant) and the synthetic-fixture checklist.

## Acceptance criteria
- [x] The token is validated against the tenant with a read-only probe. *(`query.v1` with a bearer token, 2026-10-21: HTTP 200, one `IsSelf` member)*
- [x] Inventory documented (asset types and counts, no content or names from the tenant). *(docs/dev/verification.md, as coarse levels because the repository is public)*
- [x] The read-only guard refuses a non-`GET` request and a write endpoint (tests). *(scripts/test/live-guard.test.ts)*
- [x] The live workflow runs a trivial read-only probe from `main`. *(run 39539313348, 2026-10-21: 2 tests passed after the owner approved the `live` environment)*
- [x] Template and checklist committed. *(docs/dev/verification.md)*

## Security notes
Tokens only as environment secrets. The tenant holds real third-party data: nothing from it is committed (no fixtures,
not even sanitised ones); fixtures are synthetic, written by hand (THREAT_MODEL T8, A5).

## Lessons applied
- L-003 — Plan live verification from Phase 0, not at the end.
- L-122 — Feed tools hostile upstream data.
- L-125 — Keep live-verification evidence and recipes.

## Docs to update
- docs/dev/verification.md (new)
- docs/pending-decisions/phase-0.md (sandbox access)

## Out of scope
- The full live suite (P1-12)
