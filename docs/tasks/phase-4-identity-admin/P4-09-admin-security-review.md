---
id: P4-09
title: Admin security review (owner boundaries on every writer)
phase: 4
status: review
priority: high
depends_on: [P4-04, P4-05, P4-06, P4-07, P4-12, P4-13, P4-15]
adr: ["0008", "0009", "0012", "0013"]
lessons: [L-065, L-091, L-093, L-121, L-092, L-185, L-220]
owner: "claude-agent"
---

# P4-09 — Admin security review (owner boundaries on every writer)

> Refined before work (tasks/README rule 7): the scope below lists every writer Phase 4 built and the attacker classes
> to try on each; the sister project's Phase 4 review and its follow-up tasks (P4-16 … P4-23) are the checklist of what went
> wrong there.

## Goal
Make sure no path lets an admin, a member, a stale session, a disabled user, another origin, a device-token holder or
someone controlling an identity-provider account widen access beyond what the owners allow, and that every change leaves
an audit row that says what changed.

## Scope

### Attacker classes (each tried on every writer below)
- (a) a **member**; (b) an **admin**; (c) a **signed-in user whose sign-in is older than 10 minutes** (stale session);
  (d) a **disabled user** with a still-valid cookie; (e) an **anonymous browser** on another origin or the same site;
  (f) the holder of a **device token**; (g) someone who controls an **identity-provider account whose email matches** a
  user row.

### Writers to review (the table in the review document names the evidence test for each)
1. **Admin API routes** `/api/admin/v1/*`: users (create, patch, disable, enable, end sessions, unbind), instances (create,
   patch, retarget, delete), credentials (create, rename, replace token, validate, revoke, delete), workspaces (create,
   patch, disable, delete), grants (create, patch, revoke, delete), device tokens (issue, revoke, list), member `/me/*`
   routes, `/keys`, `/setup-links`, audit reads.
2. **CLI manage commands** (local and remote clients) and **cf:setup / cf:migrate / master-key** (operator-only writers).
3. **Panel forms** under `/admin` (one `kit.form` path into the admin API): users, instances, credentials, workspaces,
   grants, tokens, connect, my access, account, audit export.
4. **Sign-in and binding**: redirect and header providers, setup links, auto-provisioning, binding by verified email,
   re-authentication, logout, session creation and rotation.
5. **Shared checks**: fetch metadata, `Origin`, CSRF token, `next` and re-auth return targets, mass assignment (extra JSON
   fields), id confusion (another user's id), races between check and write (caps, switches, last owner), audit rows
   (every change has one, with what changed, no secrets), error messages.

### Method
Adversarial reading of each writer, then a throwaway test against local fakes (memory storage, the fake identity
provider, the fake Agility; never a real tenant or Cloudflare) for every claim. Only reproduced issues are findings; each
is fixed with a regression test that fails with the fix reverted (L-121), or accepted with a reason as a decision in
[pending decisions](../../pending-decisions/phase-4.md); a fix too large for this task becomes a new task.

## Acceptance criteria
- [x] `docs/reviews/phase-4-admin-security-review.md`: scope, method, a table of every writer (who may, checks verified,
      evidence test), findings by severity, a "checked and sound" section.
- [x] Every finding is fixed with a mutation-checked regression test, or accepted as a decision (D-55 …) or a new task
      (P4-34 …) with a reason.
- [x] THREAT_MODEL rows touched are updated; new lessons are recorded; the role matrix in the admin guide and its
      executable test agree with the guards.
- [x] `pnpm lint && pnpm typecheck && pnpm test` are green and generated references are refreshed.

## Outcome
- Review: [phase-4-admin-security-review.md](../../reviews/phase-4-admin-security-review.md): a table of every writer, two
  medium and six low findings fixed with mutation-checked regression tests (`packages/auth/test/p4-review-guards.test.ts`,
  `packages/http-app/test/p4-review-writers.test.ts`, four new role-matrix rows and a changed one), no high finding.
- Fixed: an admin setting an instance CA file through the API (M1), an admin widening where writes are enabled (M2),
  pass-through without a recent sign-in, standing device tokens from a stale session, a token issued during a credential switch,
  a late validation answer vouching for a replaced token, audit rows without the changed values, and the admin API buffering a
  body before its cap.
- Decisions D-55 … D-58 (implemented as the recommended defaults); open tasks P4-34 (owner-only instance creation), P4-35
  (list and revoke setup links), P4-36 (audit before admin changes), P4-37 (validation compare-and-swap).
- Lessons L-235 … L-239; THREAT_MODEL T14, T20, T31, A5, A14 updated; role matrix, admin access guide and admin API reference
  updated; changeset `admin-security-review`.

## Security notes
THREAT_MODEL T3, T11, T13, T14, T21, T23, A5, A14; ADR-0008, ADR-0009, ADR-0012, ADR-0013.

## Lessons applied
- L-065 — Every alternate writer is an authorization boundary.
- L-091 — Validate redirect targets after parsing.
- L-093 — Re-authenticate before high-impact actions.
- L-121 — Negative authorization tests that fail when the fix is reverted.
- L-092, L-185, L-220 — bind and unbind identities with one compare-and-set.

## Docs to update
- docs/reviews/phase-4-admin-security-review.md (new)
- docs/guide/admin-access.md and docs/guide/admin-guide.md (role matrix and re-authentication list), docs/THREAT_MODEL.md,
  docs/LESSONS-LEARNED.md, docs/pending-decisions/phase-4.md

## Out of scope
- The consolidated Phase 4 review (P4-11), real identity providers (owner step), the browser E2E and ZAP runs (P4-08).
