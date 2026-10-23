---
id: P4-15
title: "Panel follow-ups: enable a disabled user, list every device token, edit number prefixes"
phase: 4
status: done
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
- [x] `POST /users/{id}/enable` is guarded like `disable` (role matrix over the pairs, re-authentication for owners and admins,
  409 when not disabled, 404 for a missing user), audited `ok` and `denied`, and a refusal writes nothing.
- [x] `GET /tokens` returns only what the caller may see, never a hash or a token value, pages by keyset without repeats or
  gaps while tokens are added or revoked, refuses a malformed cursor, and members see only their own.
- [x] `numberPrefixes` is validated on create and update on every path; hostile type names and prefixes are refused and
  change nothing; the panel form sends only a changed value.
- [x] Each panel control (enable, token list and its revoke buttons, the prefix form) is offered exactly when the API allows
  it, for every role (role matrix test against the API).
- [x] Negative authorization tests for each new route (no data and no side effect on denial); hostile strings stay inert in
  the new pages.
- [x] A workerd smoke covers one new route against D1.
- [x] The security tests are mutation-checked (L-121) and the checks recorded in the Outcome.

## Docs to update
- docs/guide/admin-panel.md, docs/dev/admin-ui.md, docs/reference/admin-api.md (generated), docs/THREAT_MODEL.md (T13, T14), docs/LESSONS-LEARNED.md

## Out of scope
- Anything not listed under Scope.

## Outcome

- **Built**: `POST /users/{id}/enable` (`users.enable` in the guarded services, audit `user.enable`, CLI `user enable`, an
  Enable button and confirmation page on the user's page); `GET /tokens` (`tokens.listAll`: the actor's visible grants, filters
  `grantId` and `userId`, keyset on `(createdAt, id)` with an opaque `after`, `limit` 1-200) and the `/admin/tokens` screen
  with a menu entry; `checkNumberPrefixes` as the one validator of `numberPrefixes` on instance create and update (shared
  `NUMBER_PREFIX_RE` and `ASSET_TYPE_NAME_RE` with the metadata layer) and the `/admin/instances/{id}/prefixes` form
  (`TextAreaField`, only a changed value is sent).
- **Admin API**: `POST /users/{id}/enable`, `GET /tokens`; `PATCH /instances/{id}` and `POST /instances` now answer 422 for a bad
  `numberPrefixes`. Reference regenerated.
- **Tests**: `packages/auth/test/guards-follow-ups.test.ts` (9), `packages/http-app/test/panel-follow-ups.test.ts` (25: role matrix
  over viewers and targets through real sessions, re-authentication, 409 and no state oracle, no session created, audit rows,
  members' own tokens only, keyset paging with writes between pages and timestamp ties, malformed cursors and limits, hostile
  labels and type names inert, forged and CSRF-less POSTs without effect, panel control equal to the API), 5 tests in
  `packages/admin-ui/test/screens.test.tsx`, the new screens in the every-screen safe-forms test, and a workerd smoke against
  D1 in `apps/worker/test/worker.test.ts` (token list page, enable, prefix validation).
- **Mutation checks (L-121)**: 23 deliberate reversions each fail at least one test: admins may enable owners and admins, no recent
  sign-in for enabling, "not disabled" checked before the role (state oracle), an active user accepted by enable, every actor
  sees every grant's tokens, a member may name a foreign grant, the user filter ignored, no id tie-break in the cursor, cursor
  not validated, the API returns the hash, type names unchecked, prefix pattern unchecked, update path unvalidated, create
  path unvalidated, Enable offered for active people, Enable offered to admins for owners, enable without a confirmation,
  the token page forwards any cursor, the token page open to members, Revoke offered for revoked tokens, unchanged prefixes
  sent, a repeated type accepted, a cursor taken from the API unchecked.
- **Found, not done**: stored number prefixes are not applied by any host (P4-30); a storage-level keyset for tokens (P4-31).
- **New**: lessons L-229 to L-231, decisions D-51 and D-52, tasks P4-30 and P4-31.
