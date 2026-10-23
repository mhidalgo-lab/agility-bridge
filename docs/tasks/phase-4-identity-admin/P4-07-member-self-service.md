---
id: P4-07
title: "Member self-service: bring your own Agility token"
phase: 4
status: done
priority: high
depends_on: [P4-04]
adr: ["0008", "0013"]
lessons: [L-065, L-069, L-073, L-093, L-121, L-147, L-197]
owner: "claude-agent"
---

# P4-07 — Member self-service: bring your own Agility token

## Goal
Members add, validate, rotate and revoke their own Agility tokens, choose which of their grants uses them, connect their
devices and see their recent changes, without an administrator handling their secret. Owners and admins keep their screens
(and also get "My access", as they hold grants too). Grants stay administrator-assigned: nobody widens their own scope.

## Scope

**Admin API (member-safe, role-checked in the guards, audited like every change)**
- Existing member-capable routes stay as they are (a member lists, reads, renames, validates, replaces and revokes only their
  own personal credentials, and lists their own grants and device tokens). Additions:
  - `DELETE /credentials/{id}` becomes allowed for a member on their **own personal** credential (removes the encrypted token;
    the storage still refuses while a grant uses it). Someone else's or a shared one stays 404 for a member / owner-admin only.
  - `POST /credentials` for a member requires a live grant of theirs on a workspace of that instance (a member cannot probe
    instances they have no business with); owners and admins may prepare theirs before being granted anything.
  - Caps (services, so every writer obeys): at most **10** personal credentials per person (revoked ones count until deleted)
    and **20** live device tokens per grant; counted again after the insert so parallel requests retreat together (relic-bridge
    P4-19).
  - `GET /me/grants`: my grants with their workspace (`slug`, `name`, `instanceId`, `credentialSource`, whether a default
    exists, `disabledAt`), because members cannot read workspaces.
  - `POST /me/grants/{id}/credential` `{ credentialId | null }`: point a live grant of mine at one of my own valid personal
    credentials of the grant's instance, or back at the workspace default only while the grant uses a credential of mine
    (relic-bridge P4-18). Scope, tools and limits are untouched; device tokens issued on the old credential are revoked when it
    moves to a personal one (existing rule). Audit action `grant.set_credential` records the credential id, never a token.
  - `GET /me/audit`: my own admin-kind audit rows, slimmed (no request ids, queries or details), newest first, at most 50.
  - The break-glass admin token is nobody: every `/me/*` route answers 403 for it.

**Panel** (`/admin/me`, role `member` and up, every call through the admin API as the signed-in person)
- "My access" overview: my grants (workspace, token in use, status), my personal tokens (hint, status), my recent changes,
  and how to create an Agility access token (the Applications page, in words: the instance's UI is not captured here).
- My tokens: add (instances of my grants only, password field, checked against Agility at once), detail (check now, rename,
  which of my grants use it), replace (needs a recent sign-in), revoke, delete (confirmation pages, CSRF).
- My grant: which token to use (my valid tokens of the instance, or the workspace default), my device tokens (list, revoke,
  issue with the one-time page and single-use handle, shared with the admin screens).
- Nav entry "My access" for every role; a link on the overview.

## Acceptance criteria
- [x] A member completes add token, use it on their grant and issue a device token in the browser, with the real API and
  the synthetic Agility fixture validator.
- [x] A member cannot see, change, replace, revoke, delete or use another member's credential, a shared credential, a grant
  or device token that is not theirs, or a workspace they are not granted; each refusal changes nothing and leaks nothing
  (API and panel, including forged ids in forms).
- [x] Replacing a token needs a recent sign-in; adding does not; a token that fails validation is stored unusable and said
  so, and the grant cannot be switched to it.
- [x] Caps hold (10 personal credentials per person, 20 live device tokens per grant), also for parallel requests.
- [x] A member can never widen scope: the credential switch touches nothing but the credential; going back to the default
  is refused for an administrator's pin; write tools are never enabled through a credential (ADR-0013).
- [x] Secrets are never echoed: not in any page, validation re-render, flash, redirect, audit row or log (tests scan).
- [x] Every change writes an audit row with the member as actor; `/me/audit` shows only their own rows.
- [x] Role matrix: every `/me` screen and route for owner, admin, member, disabled, signed-out and the admin token.
- [x] A workerd smoke renders "My access" and one member form.
- [x] Key security tests are mutation-checked (L-121), recorded under Outcome.
- [x] `docs/guide/admin-panel.md` (member section), `docs/guide/admin-access.md`, `docs/dev/admin-ui.md`, the admin API
  reference (generated), THREAT_MODEL updated; changeset added.

## Security notes
THREAT_MODEL A5, A6, T3, T14, T20.

## Lessons applied
- L-065 — Every alternate writer is an authorization boundary: the guards decide, the pages carry no ownership logic.
- L-069 — Prefer bring-your-own-token.
- L-073 — The device token handle is single use.
- L-093 — Replacing a token needs a recent sign-in.
- L-121 — Negative authorization is first-class.
- L-147 — Access tokens are full delegation and never expire.
- L-197 — Controls shown match what the API allows.

## Docs to update
- docs/guide/admin-panel.md, docs/guide/admin-access.md, docs/dev/admin-ui.md, docs/reference/admin-api.md (generated)
- docs/guide/quickstart-remote.md is **not** written here: it describes a remote deployment end to end and belongs to the
  Phase 4 docs task (P4-10), which links to the member section.

## Notes from relic-bridge (same owner)
- Its P4-10/P4-15 built a separate `/me/*` API and screens; here the existing role-aware routes already cover the member's
  own credentials, so only the gaps above are new routes.
- P4-18: going back to the default only while the grant uses a key the member owns. P4-19: caps re-checked after insert; no
  handle writes on GET/HEAD beyond the existing bounded `issueOnce`.
- Decision there (2026-10-09): no member-created grants, no per-workspace "BYO tokens not allowed" flag. Same default here
  (D-39).

## Out of scope
- Members creating their own grants, a per-workspace flag forbidding personal tokens (D-39).
- Screenshots of Agility's Applications page (needs a real tenant; the guide describes the steps in words).
- A member session list, the audit viewer for admins (P4-05), the connect page (P4-06).

## Outcome

- **Built**: `packages/admin-ui/src/screens/me.tsx` ("My access": overview with my grants, my tokens and my recent changes, add / detail /
  replace / revoke / delete for personal tokens, my grant with the token choice and my devices) and member routes for device
  tokens through the shared `tokens.tsx` (one implementation, `ADMIN_AREA` and `MEMBER_AREA`); nav entry and overview link; test
  world option to validate stored tokens against the synthetic Agility fake.
- **Admin API**: `GET /me/grants`, `POST /me/grants/{id}/credential` (audit `grant.set_credential`), `GET /me/audit` (slim rows),
  member `DELETE /credentials/{id}` for their own personal credential, a member's personal token only for an instance they have a
  live grant on, caps (10 personal credentials per person, 20 live device tokens per grant, re-checked after the insert). The
  admin token is refused on `/me/*`.
- **Tests**: `packages/http-app/test/member-self-service.test.ts` (20 tests: the browser flow with the synthetic Agility
  validating, invalid token path, re-authentication on replace, remove rules, default-switch rule, every screen per role,
  signed-out and disabled, the admin token, cross-user / shared / ungranted denials as member, owner and admin with no state
  change and no upstream call, forged API calls, scope never widened, `/me/audit` own rows only, caps with parallel requests,
  CSRF / origin / content-type refusals, HEAD and handle cap, hostile strings, secret scans of pages, audit rows and logs) and a
  workerd smoke in `apps/worker/test/worker.test.ts` (My access, a personal token validated and stored in D1, a grant switched).
- **Mutation checks (L-121)**: 18 deliberate reversions: 16 each fail at least one test (member deletes anyone's credential,
  switch ignores the grant's owner, switch accepts any credential, default allowed for an administrator's pin, invalid token
  usable, no credential-cap recheck, no token-cap recheck, token for an ungranted instance, panel shows others' credentials,
  member area shows others' grants, member area revokes any token (found surviving, the owner/admin forged-post test was
  added), the admin token counts as somebody, `/me/audit` shows everyone, replace without a recent sign-in, personal credential
  for another user, `/me/grants` lists all). Two are equivalent by design: removing the cheap *pre*-check of either cap
  changes nothing because the post-insert recheck refuses the same request.
- **relic-bridge findings folded in**: P4-10's rules (own records only, 404 for others, caps, audit with the member as actor),
  P4-15's screens (member area on the shared form kit, forged ids give the 404 page), P4-18 (back to the default only while the
  grant uses the member's own token), P4-19 (caps re-checked after insert; handles bounded, none for HEAD).
- **Not done / notes**: no screenshots of Agility's Applications page (needs a real tenant; the guide describes the steps);
  `docs/guide/quickstart-remote.md` is left to P4-10 (it needs the whole remote setup); the token is stored first and validated
  right after (the resolver denies an unvalidated or invalid credential, so it is inert until valid).
- **New**: lessons L-205 to L-208, decisions D-39 and D-40, changeset.
