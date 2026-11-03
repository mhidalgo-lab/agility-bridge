---
id: P9-05
title: Support, versioning and deprecation policy
phase: 9
status: review
priority: medium
depends_on: [P8-12]
adr: []
lessons: [L-027, L-045]
owner: "claude (lane D)"
---

# P9-05 — Support, versioning and deprecation policy

> Scope and acceptance criteria refined 2026-11-03 (tasks/README rule 7). P8-12 is waived as a dependency by the owner
> (live pass pending).

## Goal
Users know what is supported, for how long, and how changes are announced.

## Scope
- Semantic versioning: what counts as a breaking change (tool names and schemas, configuration, CLI flags, HTTP routes,
  storage migrations), and how pre-1.0 differs.
- Supported Node (engines and the CI matrix), Agility (hosted; on-premises minimum unknown without a tenant), MCP
  protocol revisions and clients (from the client compatibility page).
- Deprecation window (at least one minor and six months), tied to the machine-readable registry (L-045).
- Security fix policy consistent with SECURITY.md and the `release/x.y` backport path of P9-07.
- Upgrade notes: reconnect clients after an upgrade (L-027), migrations, rollback.
- Existing docs that contradict the policy are fixed.

## Acceptance criteria
- [x] `docs/guide/versioning.md` covers semver (breaking-change list), supported Node, Agility, protocol revisions and
      clients, the deprecation window, and the security fix policy.
- [x] `docs/guide/upgrading.md` has the upgrade procedure (reconnect clients, storage migrations, rollback limits) and
      where release notes live.
- [x] The Node versions in the policy equal `engines` and the CI matrix.
- [x] The minimum on-premises Agility version is marked *unverified* and recorded as a decision.
- [x] Both pages are linked from SECURITY.md and the README; SECURITY.md's supported-versions table points to the policy.
- [x] Contradictions found in existing docs (README status, deprecation examples) are fixed.
- [x] *owner:* the owner confirms the 1.x support window (decision) before 1.0 (P9-08). Confirmed 2026-11-03 (D-366 (a)).

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-027 — Clients cache tool lists.
- L-045 — Deprecate on purpose.

## Docs to update
- docs/guide/versioning.md (new)
- docs/guide/upgrading.md (new)

## Out of scope
- Anything not listed under Scope.
