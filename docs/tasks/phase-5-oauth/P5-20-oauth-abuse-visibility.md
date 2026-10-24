---
id: P5-20
title: Operator view of OAuth abuse refusals and caps
phase: 5
status: todo
priority: low
depends_on: [P5-08, P5-09]
adr: ["0009"]
lessons: [L-079, L-251]
owner: ""
---

# P5-20 — Operator view of OAuth abuse refusals and caps

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7). Created by P5-09.

## Goal
An operator can see, without reading the audit table, whether the OAuth abuse limits are being hit and how full the
registration caps are, so a limit is tuned from evidence and a flooded deployment is noticed.

## Scope
- On the admin OAuth apps page (P5-08): live dynamic registrations and stored documents against their caps
  (`oauthRegistrations.count()`), and the `oauth.request.refused` and `oauth.client.refused` rows of the last 24 hours grouped
  by surface and scope.
- An admin API read for the same numbers (no new write, no address in the response).
- A note in the operator guide: what to change when a limit is reached by real users (raise it) versus by a flood
  (`AB_OAUTH_DCR=off`, a WAF rule).

## Acceptance criteria
- [ ] The page and the API show the caps, the usage and the refusal counts for the window, for administrators only.
- [ ] No address, hash of an address, token or client secret appears in the page or the API (asserted).
- [ ] Negative authorization: members and anonymous callers get no data.

## Security notes
THREAT_MODEL T10, T20, T25.

## Lessons applied
- L-079 — Separate abuse controls per surface.
- L-251 — Cap by what is stored, and show it.

## Docs to update
- docs/guide/admin-panel.md, docs/reference/admin-api.md (generated), docs/dev/oauth.md

## Out of scope
- Changing limits from the panel (settings stay deployment configuration); alerting.
