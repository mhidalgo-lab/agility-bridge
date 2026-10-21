---
id: P0-04
title: Security tooling baseline
phase: 0
status: done
priority: high
depends_on: [P0-03]
adr: []
lessons: [L-130, L-132, L-010]
owner: "Matias Hidalgo"
---

# P0-04 — Security tooling baseline

## Goal
Static analysis, secret scanning, dependency review and a scorecard from the first commit, without production credentials.

## Scope
- CodeQL for TypeScript (PRs, `main`, weekly).
- gitleaks with custom rules: `ab_live_`/`ab_test_` device tokens, `ab_admin_` admin tokens, `v<N>:` master keys, Agility access tokens (generic high-entropy bearer rule until P0-06 shows their format).
- Dependency review on PRs; `pnpm audit --audit-level high` gate.
- Renovate: weekly, grouped, digests pinned, majors need approval, minimum release age, regex managers for CI tool versions with SHA-256.
- OpenSSF Scorecard workflow.
- Repository settings checklist (rulesets, secret scanning and push protection, private vulnerability reporting, environments) for the owner.

## Acceptance criteria
- [x] A planted fake token in a test path fails gitleaks (proving each custom rule fires); an allowlist covers the test fixture. *(`scripts/check-gitleaks-rules.ts`, run in the gitleaks job; verified locally that removing a fixture fails it)*
- [x] CodeQL runs on PRs; Scorecard publishes results. *(CodeQL on PR #12 and `main`; Scorecard 6.6 on scorecard.dev, 2026-10-21)*
- [x] Renovate configuration validates. *(`renovate-config-validator --strict`, Renovate 44.172.2, 2026-10-20; `scripts/test/renovate.test.ts` checks the tool-pin manager)*
- [x] The owner has applied and ticked the repository settings checklist. *(docs/security/repo-settings.md, 2026-10-21)*

## Security notes
THREAT_MODEL T8, T18.

## Lessons applied
- L-130 — Pin and verify everything the pipeline runs.
- L-132 — Harden dependency intake.
- L-010 — Every security claim needs evidence.

## Docs to update
- docs/security/repo-settings.md
- SECURITY.md

## Out of scope
- Browser E2E and DAST (P4-08)
