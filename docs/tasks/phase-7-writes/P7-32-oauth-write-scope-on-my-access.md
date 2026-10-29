---
id: P7-32
title: "Show the OAuth write scope on My access and the administrators' device list"
phase: 7
status: todo
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
- Add the granted write scope to `OAuthDevice` (from the grant record's `scope`), the panel list, the admin API and CLI reference.
- Label it plainly ("can ask for changes") and keep the disconnect button the way to remove it.

## Acceptance criteria
- [ ] The list shows a write-capable app differently from a read-only one, on My access and in the administrators' list.
- [ ] Generated API and CLI references are refreshed; no token or scope string from an untrusted source is rendered unescaped.

## Docs to update
- docs/guide/oauth-how-it-works.md
- docs/reference/admin-api.md

## Out of scope
- Changing a device's scope in place (P7-33).
