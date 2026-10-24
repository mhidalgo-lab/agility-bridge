---
id: P5-14
title: Device last-used time and idle expiry
phase: 5
status: todo
priority: low
depends_on: [P5-04, P5-05]
adr: ["0009"]
lessons: [L-090]
owner: ""
---

# P5-14 — Device last-used time and idle expiry

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7). Created by P5-04: the
> list of connected apps cannot say when an app was last used, so a forgotten or phished approval stays until its refresh
> lifetime (30 days by default) or the grant ends.

## Goal
A person can tell which connected app is still in use, and an app nobody has used for a while loses its access.

## Scope
- Record the last token issuance or MCP request per device (at most every few minutes, like device tokens'
  `lastUsedAt`), without personal data and without a write per request.
- Show "last used" on My access; optional idle expiry (`AB_OAUTH_IDLE_TTL`, off by default) enforced at refresh.
- Decide where the value lives (grant metadata is rewritten by the provider on refresh; a separate `kv` row per device
  is cheaper to update).

## Acceptance criteria
- [ ] The device list shows last-used; an idle device is refused at refresh when the switch is on (tested with moved time).
- [ ] No write on the MCP hot path beyond the existing throttle.

## Security notes
THREAT_MODEL T9, T15 (T25: no personal data in the record).

## Lessons applied
- L-090 — an idle expiry ends access at a token request by the device, never at an authorization navigation.

## Docs to update
- docs/dev/oauth.md, docs/guide/oauth-phone.md, docs/guide/configuration.md

## Out of scope
- Administrator views of other people's devices (P5-08).
