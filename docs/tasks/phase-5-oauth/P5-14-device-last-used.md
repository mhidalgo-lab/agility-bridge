---
id: P5-14
title: Device last-used time and idle expiry
phase: 5
status: done
priority: low
depends_on: [P5-04, P5-05]
adr: ["0009"]
lessons: [L-090]
owner: "agent"
---

# P5-14 — Device last-used time and idle expiry

> Refined 2026-10-28 (scope below is what is built; nothing here needs a real client). Created by P5-04: the list of
> connected apps cannot say when an app was last used, so a forgotten or phished approval stays until its refresh
> lifetime (30 days by default) or the grant ends.

## Goal
A person can tell which connected app is still in use, and an app nobody has used for a while loses its access.

## Scope
- One storage row per device, `oauth-used:<userId>:<grantId>` (a `kv` row, not grant metadata, which the provider
  rewrites on refresh), holding the epoch ms of the last token issuance or MCP request. Nothing else: no address, no
  user agent, no token (T25). It is deleted when the device is revoked and expires on its own after the longest
  token lifetime (D-131).
- Writes: at most one per device every 5 minutes per process (an in-memory throttle map of timestamps, bounded; no
  read and no write on the MCP hot path inside the interval). Token issuance (code exchange, refresh) counts too.
- "Last used" on My access (connected apps list and `GET /me/oauth-devices`, field `lastUsedAt`; null = not yet seen).
  The administrators' list (P5-08) is out of scope.
- `AB_OAUTH_IDLE_TTL` (off by default; 1 h to 365 d): at a refresh, a device whose last use is older than this is refused
  as `device_idle` (final: the provider revokes the device, audited as `oauth.token.refused`). A device without a
  row (approved before the switch) is not idle; the refresh creates its row. The code exchange never checks it.
- Settings are validated like the other durations; the CLI and Worker pick the variable up through the shared settings.

## Acceptance criteria
- [x] The device list shows last-used; an idle device is refused at refresh when the switch is on (tested with a moved
  stored time, on memory, SQLite and workerd/D1).
- [x] No write on the MCP hot path beyond the existing throttle (tested: repeated requests inside the interval do not
  rewrite the row).
- [x] The record holds a timestamp only; revoking a device deletes it (asserted).

## Security notes
THREAT_MODEL T9, T15 (T25: no personal data in the record).

## Lessons applied
- L-090 — an idle expiry ends access at a token request by the device, never at an authorization navigation.

## Docs to update
- docs/dev/oauth.md, docs/guide/oauth-phone.md, docs/guide/configuration.md

## Out of scope
- Administrator views of other people's devices (P5-08).
