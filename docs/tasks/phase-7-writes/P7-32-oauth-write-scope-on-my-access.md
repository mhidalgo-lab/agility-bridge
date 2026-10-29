---
id: P7-32
title: "Show the OAuth write scope on My access and the administrators' device list"
phase: 7
status: in-progress
priority: low
depends_on: [P7-24]
adr: ["0013"]
lessons: [L-133]
owner: ""
---

# P7-32 — Show the OAuth write scope on My access

> Filed by [P7-24](P7-24-oauth-write-scope.md). Refine scope and acceptance criteria before starting.

## Goal
A person (and an administrator looking at a member's apps) can see which connected apps may use write tools, not only that
they are connected. Today the granted scope is in the `oauth.authorize` audit row and in the provider's grant record, but the
device list does not show it.

## Scope
Refined 2026-10-29.

- `OAuthDevice` (and the administrators' `OAuthAdminDevice`) gains `canWrite: boolean`: the grant record's `scope` holds `mcp:write` (the scope the person ticked on the consent screen and the server granted, P7-24). It is a fact about the authorization, not about whether a write would succeed today: the server switch, the workspace, the grant and a personal credential still decide that (ADR-0013), so the label says "can ask for changes", never "can change".
- Both device routes (`GET /me/oauth-devices`, `GET /oauth/devices`) return it; the panel shows a "Changes" column on My access and on the administrators' list: a badge "can ask for changes" or "read only". The disconnect button stays the way to remove it (a scope is not changed in place, D-202).
- Nothing in the badge or the reference comes from an untrusted source: it is a boolean derived from a scope string the server issued; no scope string is rendered.
- No new route, no change to what a token may do.

## Acceptance criteria
- [x] The list shows a write-capable app differently from a read-only one, on My access and in the administrators' list (a granted-write and a read-only device in each).
- [x] The generated admin API reference is refreshed; the CLI has no OAuth device command (nothing to refresh); no scope string is rendered.
- [x] A person still sees only their own devices and the administrators' list keeps its role rules (existing negative tests unchanged and passing).

## Docs to update
- docs/guide/oauth-how-it-works.md
- docs/reference/admin-api.md

## Out of scope
- Changing a device's scope in place (P7-33).
