---
id: P0-06
title: "Spike: Agility API behaviour, limits and fixtures"
phase: 0
status: in-progress
priority: high
depends_on: [P0-01, P0-12]
adr: ["0010", "0011", "0012", "0014"]
lessons: [L-001, L-002, L-046, L-048, L-052, L-137, L-138, L-139, L-140, L-141, L-144, L-147, L-148, L-149, L-162, L-163]
owner: "Matias Hidalgo"
---

# P0-06 — Spike: Agility API behaviour, limits and fixtures

## Goal
Measure how Agility really behaves for everything the core will depend on, answer the P0-06 questions in RESEARCH §8, and produce sanitised fixtures.

## Scope
- Probe scripts under `spikes/agility-api/` (TypeScript, `fetch` only, tokens from the environment).
- Authentication: access tokens with `query.v1` vs `query.legacy.v1`; 401 bodies; header forms.
- `query.v1`: nested selections, `filter` + `with` binding with hostile values (quotes, commas, pipes, brackets, Unicode, 10,000-character strings, arrays), several queries per call, `page` and `needTotal` cost, behaviour without `page`, sort stability.
- `meta.v1`: size, parse time, how to fingerprint changes (ETag, version, hash), custom attributes, operations and validators.
- Numbers: the prefix per asset type on each instance; resolving a number across asset types in one query.
- Relations: task/test parent, children, `Super`/`Subs`, owners, team, sprint, status per type, and the idiom for "an Agility project and its descendants".
- Scope strategy per asset type (ARCHITECTURE §6.3): which types have a direct `Scope` relation, the parent path for derived types (tasks, tests, attachments, links, effort, comments), how sprints relate to projects, which types are global (members, teams, list types).
- Whether administrators can define custom asset types or only custom fields and list values; how custom fields appear in metadata.
- Team membership semantics: team-room participants, a roster relation, or only derivation from assignments.
- History: `Hist` vs `asof` cost; an activity-stream sample.
- Errors: 400/401/404/405/429/500 bodies and content types, as far as reads can trigger them. Rate-limit quotas,
  `RetryAfter` accuracy and the error-count quota are **not** probed on the third-party tenant (D-01); they move to the
  writable sandbox and stay on the "not verified" list until then.
- Latency and response sizes for typical queries (25 and 100 work items with owners and status).
- Writes are **out of scope** for this spike (D-01: the only tenant is read-only). Single-target `api/asset` update vs
  `rest-1.v1` POST, `previewOnly=true` side effects, comments (`Expression`), effort (`Actual`), `QuickClose`,
  `Reactivate` and read-after-write lag are measured on the writable sandbox before Phase 7 (P7-07) and listed as
  "not verified" here.
- `assetdetail.v1` links per asset type; attachment metadata.
- On-premises instance if available: version, TLS with a private CA, base-URL shapes.

## Acceptance criteria
- [x] `spikes/agility-api/RESULTS.md` with exact measurements, instance versions and dates, and an explicit "not verified" list.
- [x] Every fact in RESEARCH §1 is marked `live`, `docs` or corrected.
- [x] Synthetic fixtures written by hand to match the measured shapes; nothing from the third-party tenant is committed (D-01), not even sanitised responses; gitleaks clean; the synthetic-fixture checklist signed in the PR. *(packages/core/test/fixtures/agility/, checklist signed in the PR)*
- [x] Every probe ran through the P0-12 read-only guard.
- [ ] ADR-0011 accepted or superseded with evidence; ADR-0010 and ADR-0014 numbers updated. *(evidence and numbers added; acceptance of ADR-0011 is the owner's)*
- [x] Every surprise becomes a lesson in LESSONS-LEARNED.md. *(L-162, L-163)*

## Security notes
Sandbox only, least-privilege members, synthetic data. Raw captures are git-ignored and deleted after sanitisation (THREAT_MODEL T8). Do not trip quotas on shared or production instances (A10).

## Lessons applied
- L-001 — Measure before you build.
- L-002 — A spike is done only when it ran in production-like conditions.
- L-046 — Classify errors precisely.
- L-048 — Stay well under the provider's concurrency.
- L-052 — Normalise heterogeneous representations.
- L-137 — Always send an explicit page size.
- L-138 — Validate before sending; quotas can count errors.
- L-139 — `with` is substitution, not a prepared statement.
- L-140 — A 404 means "not found or not visible".
- L-141 — Number prefixes vary per instance.
- L-144 — `total = -1` means "not computed".
- L-147 — Access tokens are full delegation and never expire.
- L-148 — Learn the model from metadata, then verify relations live.
- L-149 — Send UTC, read the UTC variants.

## Docs to update
- docs/RESEARCH.md §1 and §8
- docs/adr/0010, 0011, 0014
- docs/LESSONS-LEARNED.md

## Out of scope
- Building the production client (P1-02)
