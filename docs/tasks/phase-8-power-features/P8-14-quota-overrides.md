---
id: P8-14
title: Per-grant and per-workspace quota overrides
phase: 8
status: todo
priority: low
depends_on: [P8-09]
adr: ["0010"]
lessons: [L-116, L-080]
owner: ""
---

# P8-14 — Per-grant and per-workspace quota overrides

## Goal
Let an owner give one grant or workspace a smaller (never larger) daily or monthly Agility request quota than the deployment's, the way a grant already lowers its own write limit and request rate.

## Scope
- A `quota` object in the grant and workspace policy (`daily`, `monthly`), validated like `rateLimit.writesPerHour`: it can only lower the server's `AB_QUOTA_DAILY` and `AB_QUOTA_MONTHLY`, and an administrator cannot loosen what an owner set.
- Admin API fields, `agility-bridge grant` flags, panel form fields and the effective value shown on the grant page and in `whoami`.
- Effective limits resolved in the access model and carried on `EffectiveAccess`; the meter of P8-09 reads them instead of the deployment values.

## Acceptance criteria
- [ ] The effective quota is the lowest of the deployment, workspace and grant values; a higher value is refused with a message naming the cap.
- [ ] Negative authorization tests: a member cannot set or read another grant's quota; an admin cannot raise an owner's value.
- [ ] The admin API reference, CLI reference and panel show the new fields; the access cache key and the query cache key are unaffected (the quota is not a scope dimension).

## Security notes
THREAT_MODEL T5, A10.

## Lessons applied
- L-116 — Quotas count logical upstream calls.

## Docs to update
- docs/guide/query-limits.md, docs/guide/access-model.md, docs/reference/admin-api.md, docs/reference/cli.md

## Out of scope
- Raising a quota above the deployment value.
