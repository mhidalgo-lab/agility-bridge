---
id: P5-20
title: Operator view of OAuth abuse refusals and caps
phase: 5
status: done
priority: low
depends_on: [P5-08, P5-09]
adr: ["0009"]
lessons: [L-079, L-251]
owner: "agent"
---

# P5-20 — Operator view of OAuth abuse refusals and caps

> Refined 2026-10-28 (everything below can be built and tested without a real client). Created by P5-09.

## Goal
An operator can see, without reading the audit table, whether the OAuth abuse limits are being hit and how full the
registration caps are, so a limit is tuned from evidence and a flooded deployment is noticed.

## Scope
- `GET /oauth/abuse` (owners, like the clients list it sits beside; 404 when OAuth is off): live dynamic registrations and
  stored document clients against their caps and whether each is enabled, the configured limits (numbers only), and the
  `oauth.request.refused` and `oauth.client.refused` audit rows of the last 24 hours grouped by reason, surface, scope and
  client kind with a count and the newest time. Reads at most 1,000 rows of each kind and says when it hit that.
- A section on the OAuth apps page (`/admin/oauth/clients`) showing the same. A failure to load it does not hide the clients.
- The response is built from allowlisted, shape-checked fields: no address, address hash, client id, host, request id, token or
  secret can reach it (asserted with seeded rows that contain them).
- Counts are audit rows, and a limit is recorded once per window it is reached in (P5-09), so a count is "windows in which the
  limit was reached", not requests; the page and the guide say so.
- Operator guide: what to do when a limit is reached by real users (raise it) versus by a flood (`AB_OAUTH_DCR=off`, a WAF rule).
- Not here: administrators who are not owners (the registration numbers are an owner view, D-132); alerting; changing limits.

## Acceptance criteria
- [x] The page and the API show the caps, the usage, the limits and the refusal counts for the window, for owners only.
- [x] No address, hash of an address, token or client secret appears in the page or the API (asserted).
- [x] Negative authorization: members, administrators and anonymous callers get no data (memory, SQLite and workerd/D1 for the
  API; role tests with sessions for the page).

## Security notes
THREAT_MODEL T10, T20, T25.

## Lessons applied
- L-079 — Separate abuse controls per surface.
- L-251 — Cap by what is stored, and show it.

## Docs to update
- docs/guide/admin-panel.md, docs/reference/admin-api.md (generated), docs/dev/oauth.md

## Out of scope
- Changing limits from the panel (settings stay deployment configuration); alerting.
