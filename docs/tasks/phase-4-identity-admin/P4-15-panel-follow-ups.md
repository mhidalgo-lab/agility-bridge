---
id: P4-15
title: "Panel follow-ups: enable a disabled user, list every device token, edit number prefixes"
phase: 4
status: in-progress
priority: low
depends_on: [P4-04, P4-12]
adr: ["0008"]
lessons: [L-065, L-197, L-198, L-199, L-220, L-221]
owner: "agent"
---

# P4-15 — Panel follow-ups: enable a disabled user, list every device token, edit number prefixes

> Found while building P4-04: three things the screens cannot do because the admin API has no endpoint for them.

## Goal
Close the gaps P4-04 left on purpose, each through a new admin API endpoint with negative authorization tests (no screen
bypasses the API).

## Scope
Three additions, each through the admin API first (the screens call the API only, never storage):

1. **Enable a disabled user.** `POST /users/{id}/enable`, audited `user.enable`. Guard, same shape as `disable`: owner or
   admin; an owner for owners and admins, with a recent sign-in for those (the break-glass token is exempt); an admin for
   members. A user who is not disabled answers 409 and nothing is written. Re-enabling brings back everything the user still
   holds (their grants and device tokens that were not revoked), so the confirmation page says so. No session exists to
   restore, and none is created: the person signs in again. Panel: an "Enable..." button with a confirmation page on the
   user's page, shown only where the API would allow it (`canManage` and disabled), and the stale "no way to enable them again"
   sentence on the disable page goes away.
2. **List device tokens panel-wide.** `GET /tokens?grantId=&userId=&after=&limit=` returns `{ data, next }`: the tokens
   the caller may see (owner and admin: every token; a member: the tokens of their own grants only; a grant that is not yours
   is "not found", a `userId` that is not yours matches nothing), newest first, keyset-paged on `(createdAt, id)` with an
   opaque `after` cursor (a malformed cursor is a 422), `limit` 1-200 (default 50). Each item is the existing device-token
   record (id, prefix, label, dates; never the hash and never a token value) plus the owning grant's `userId`, `workspaceId`
   and `grantLabel`. Panel: `/admin/tokens` for owners and admins (name and device, token prefix, status, last used, the grant
   it belongs to, a link to the grant, a revoke button per live token), filters for a grant and a person, a pager that carries
   the cursor, and a menu entry.
3. **Edit an instance's number prefixes.** The API already accepts `numberPrefixes` on `PATCH /instances/{id}` but checked
   nothing. The services now validate it on create and update (`{ "<AssetTypeName>": "<A-Z, 1-4 letters>" }`, at most 64
   entries, a type name must match the same `ASSET_TYPE_NAME_RE` the metadata layer uses, `null` clears), so the admin API,
   the CLI and the panel share one validator (L-065). The prefix and type regexes are exported once from core and used by the
   metadata layer as well. Panel: a "Type=PREFIX" form (one pair per line) on the instance page, for owners and admins, that
   sends only what changed.

## Not in this task (found while refining)
- The stored `numberPrefixes` never reach the metadata layer: `MetadataService` takes `prefixOverrides` but no host passes
  the stored value, so the field is stored and shown but number lookup still learns prefixes from Agility. Feeding them in
  touches `InstanceRef`, the access resolver and the metadata cache: task P4-30. The panel says so next to the form.
- A storage-level keyset for access tokens (the list is read whole and paged in the service, which the per-grant cap of 20 live
  tokens keeps small): task P4-31, when a deployment has thousands.

## Acceptance criteria
- [ ] `POST /users/{id}/enable` is guarded like `disable` (role matrix over the pairs, re-authentication for owners and admins,
  409 when not disabled, 404 for a missing user), audited `ok` and `denied`, and a refusal writes nothing.
- [ ] `GET /tokens` returns only what the caller may see, never a hash or a token value, pages by keyset without repeats or
  gaps while tokens are added or revoked, refuses a malformed cursor, and members see only their own.
- [ ] `numberPrefixes` is validated on create and update on every path; hostile type names and prefixes are refused and
  change nothing; the panel form sends only a changed value.
- [ ] Each panel control (enable, token list and its revoke buttons, the prefix form) is offered exactly when the API allows
  it, for every role (role matrix test against the API).
- [ ] Negative authorization tests for each new route (no data and no side effect on denial); hostile strings stay inert in
  the new pages.
- [ ] A workerd smoke covers one new route against D1.
- [ ] The security tests are mutation-checked (L-121) and the checks recorded in the Outcome.

## Docs to update
- docs/guide/admin-panel.md, docs/dev/admin-ui.md, docs/reference/admin-api.md (generated), docs/THREAT_MODEL.md (T13, T14), docs/LESSONS-LEARNED.md

## Out of scope
- Anything not listed under Scope.
