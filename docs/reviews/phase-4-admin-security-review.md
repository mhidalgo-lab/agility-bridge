# Phase 4 admin security review (P4-09)

- **Scope:** every writer Phase 4 built, on top of Phase 2's guards: the admin API (`/api/admin/v1/*`), the command-line
  management commands (local and remote), the panel forms under `/admin`, member self-service (`/me/*`), sign-in, setup links,
  binding, re-authentication, logout, owner-only unbind, enabling users, the token list, number prefixes, `cf:setup --sign-in`,
  `cf:migrate` and the master-key commands (P4-01 … P4-08, P4-10, P4-12 … P4-15).
- **Date:** 2026-10-23. **Branch:** `task/P4-09-admin-security-review`, on top of `main` after #99.
- **Method:** an adversarial read of each writer from seven attacker positions: (a) a member, (b) an admin, (c) a signed-in user
  whose sign-in is older than 10 minutes, (d) a disabled user with a still-valid cookie, (e) an anonymous browser on another
  origin or the same site, (f) the holder of a device token, (g) someone who controls an identity-provider account with a
  matching email. Every claim was reproduced with a throwaway test against local fakes (memory storage, the fake identity
  provider, the fake Agility; no real tenant, no Cloudflare, no secrets) before it counted as a finding. The sister project's
  Phase 4 review and its follow-up tasks (atomic binding and last owner, session cap, member key switching, bounded
  self-service writes, owner-only admin management, grant form limits) were used as a checklist of what went wrong there; each
  of those classes is covered below.
- **Evidence:** the probes became permanent tests, `packages/auth/test/p4-review-guards.test.ts` and
  `packages/http-app/test/p4-review-writers.test.ts`, plus new rows in the role matrix (`scripts/test/role-matrix.test.ts`).
  Tests named `fix: ...` are the regression tests; **each failed with its fix reverted** (checked one mutation at a time, L-121).
  The other tests record what holds.
- **Checks:** `pnpm lint && pnpm typecheck && pnpm test` green (counts at the end).

## Verdict

**Ready, with the fixes on this branch and four decisions for the owner.** No high finding. Two medium findings (an
administrator could set an instance's TLS trust through the API, and could widen where an owner had enabled writes) and six low
ones are fixed with regression tests. The design held where it matters most: one set of guards shared by every writer, roles
read on every request, CSRF and fetch metadata on every cookie change, a compare-and-set for binding and unbinding, no GET that
changes state, and no secret in any audit row, log line or error. The open items are choices, not defects: whether
administrators may add an instance at a new origin (D-55), and three smaller ones (D-56 … D-58).

## Writers: who may, what was checked, where the evidence is

"Recent" means a sign-in from the last 10 minutes (L-093); the break-glass token counts as an owner with a recent sign-in
except where noted. Every row's refusals were checked to change nothing and to write a `denied` audit row.

| Writer | Who may | Checks verified | Evidence |
|---|---|---|---|
| `POST /users`, panel *Add user* | admin: members; owner + recent: admins and owners | role escalation, `idp`/`idpSubject`/extra fields (422), control characters in the email, role recorded in the row (fixed, L5) | role matrix rows *Add a member*, *Add an admin or an owner*; `p4-review-writers` *mass assignment*, *audit rows* |
| `PATCH /users/{id}`, role form | admin: members; owner + recent: anyone else or a role above member | no `disabledAt`/binding through a patch, last owner (storage trigger), previous role audited | role matrix *Change a role*; `sessions.test` *roles through real sessions*, *never demotes or disables the last owner*; `p4-review-writers` *mass assignment* |
| `POST /users/{id}/disable`, `/enable` | admin: members; owner (+ recent for owners and admins) | sessions deleted, a cookie never revives, a device token stops, no state oracle (409 after the role check) | role matrix; `guards-follow-ups.test`; `panel-follow-ups.test`; `p4-review-writers` *a disabled user's cookie, device token and forms all stop* |
| `POST /users/{id}/sessions/revoke`, logout, *end all my sessions* | yourself; owner anyone; admin members | member asking about another user gets 404 | `sessions.test` *ending sessions*, *logout and the account page* |
| `POST /users/{id}/unbind` | owner + recent, not yourself | retyped email, compare-and-set, sessions ended after the write, subject never in a row | `guards-unbind.test`, `owner-unbind.test`, `apps/cli/test/manage.test` |
| `POST /instances` | admin and owner; **a CA file (`tls`): owner + recent** (fixed, M1) | `tls` set by admin through the API | `p4-review-guards` *instances: TLS trust*; role matrix *Add an instance with its own TLS trust*; `p4-review-writers` *an admin cannot add an instance with a CA file* |
| `PATCH /instances/{id}`, `DELETE` | admin and owner | origin and `tls` not patchable (422), unused only on delete | `p4-review-writers` *mass assignment*; `admin.test` |
| `POST /instances/{id}/retarget` | owner + recent | probe first, credentials and grants revoked, previous and new host audited (fixed, L5) | `admin.test`; `p4-review-writers` *audit rows* |
| `POST /credentials` and `PATCH`, `/token`, `/validate`, `/revoke`, `DELETE` | shared: admin and owner (replace token: + recent); personal: that person only, for an instance they hold a grant on | another person's id answers 404, caps of 10 under parallel requests, the late validation answer dropped (fixed, L4) | `member-self-service.test`; `p4-review-writers` *id confusion*; `p4-review-guards` *a validation that started before a token replacement* |
| `POST`/`PATCH /workspaces`, `disable`, `DELETE` | admin and owner; write settings, write tools, pass-through: owner + recent (pass-through fixed, L1); **widening projects or asset types where writes are enabled: owner + recent** (fixed, M2) | `instanceId`/`id` not patchable, default credential shared only and of the same instance (trigger), narrowing allowed for admins | role matrix (4 rows); `p4-review-guards` *pass-through*, *where an owner enabled writes*; `p4-review-writers` |
| `POST`/`PATCH /grants`, `revoke`, `DELETE` | admin and owner; write tools: owner + recent; **widening a write grant: owner + recent** (fixed, M2) | `userId`/`workspaceId`/`revokedAt` not patchable, a personal credential only for its own user, tokens revoked on a switch to a personal one | role matrix (*Grant write tools*, *Widen a grant that has write tools*); `p4-review-guards` *a grant an owner gave write tools* |
| `POST /grants/{id}/tokens`, `POST /tokens/{id}/revoke`, `GET /tokens` | members: their own grants; admin and owner: any grant on a shared credential; **a token past 90 days or `never`: recent** (fixed, L2) | foreign grant 404, 20 live per grant under parallel requests, personal-credential grants only for their owner, **a token issued during a switch is revoked** (fixed, L3), token id in the audit row (fixed, L5) | `member-self-service.test`; `p4-review-guards` *device tokens that outlive the default*, *a token issued while its grant moves*; `p4-review-writers` *id confusion* |
| `/me/grants`, `/me/grants/{id}/credential`, `/me/audit` | the signed-in person; the break-glass token is nobody | only their own valid token of that instance, reset to the default only from their own token, no scope, tool or limit change | `member-self-service.test` (16 mutations) |
| `GET /audit`, `/audit/stats`, `/tools`, `/keys` | audit: admin and owner everything, member own rows; statistics, tools: admin and owner; keys: owner | `userId` taken from the session for a member, another `userId` 403 | `admin-audit.test`; `sessions.test`; `p4-review-writers` |
| `POST /keys/{id}/retire` | owner + recent | version validation, reason audited | `admin.test`, `sessions.test`, `apps/worker/test/scheduled.test`, role matrix |
| `POST /setup-links` | owner + recent | code in the URL fragment only, never in a row or log, hash prefix as id | `identity.test` *owner setup links* |
| Every API request | session cookie or bearer, never both | fetch metadata, `Origin`, CSRF token on unsafe methods, a bad bearer never falls back to a cookie, a device token is no admin credential, body cap enforced while streaming (fixed, L6) | `sessions.test` *CSRF and request origin*; `p4-review-writers` *a device token is no admin credential*, *does not buffer a body*, *a stale session cannot take any step* |
| CLI `agility-bridge ...` (local and remote) | the operator (local: the database and the key; remote: the admin token) | the same admin API handlers, `via: cli` rows, secrets never in argv | `apps/cli/test/manage.test` |
| Panel forms under `/admin` (40 `POST` routes) | each through `kit.form(minRole)`: origin, fetch metadata, form type, 16 KiB cap, one CSRF field, then the API as the signed-in user | every restriction a screen shows is also a guard (the CA file was not: M1, L-235), hidden controls equal the API's answers | `admin-screens.test`, `panel-follow-ups.test`, `e2e/security.spec.ts` |
| Sign-in, binding, auto-provisioning | any verified identity for a row it matches; allowlists for unknown ones | PKCE, state single use and bound to the browser, nonce, issuer, one identity per user bound by compare-and-set, email never moves an account, verified emails only | `identity.test`, `packages/auth/test/identity/*`, `apps/cli/test/sign-in.test` (two connections, one file) |
| Re-authentication, `next`, logout | the same person again; local paths only after parsing | `/auth/reauth` creates and binds nobody, stale `auth_time` refused, `next` checked after parsing and again before the `Location` | `sessions.test` *re-authentication*, `identity.test` *redirect targets* |
| `cf:setup --sign-in`, `cf:migrate`, `master-key` | the operator who holds the Cloudflare account or the database | client secrets only on stdin to `wrangler secret put`, never to the secrets file, warnings for risky policy | `scripts/test/cf-setup.test`, `cf-migrate.test` |

## Findings

Severity is the impact if exploited, weighed by how easy it is. **fixed** = on this branch with a regression test that fails
when the fix is reverted. **decision** = recorded in [pending decisions](../pending-decisions/phase-4.md) at the recommended
default (implemented as that option). **task** = an open follow-up.

### Medium

**M1 — An administrator could set an instance's TLS trust through the API** — **fixed.** The panel's *Add instance* form told
non-owners "Only an owner can set this" for the CA file, and A14 says TLS trust is the owners', but `POST /instances` accepted
`tls: { "caFile": "/any/path.pem" }` from an admin and stored it: a path on the server's disk that the Node server reads as the
trust anchor for that instance, which decides whom stored member tokens are sent to. The rule lived in the form, not in the
guard (L-065, L-235). `guardedServices.instances.create` now needs an owner with a recent sign-in when `tls` is given
(`p4-review-guards`, `p4-review-writers`; the role matrix has the row). Residual and the choice behind it: D-55.

**M2 — An administrator could widen where an owner had enabled writes** — **fixed.** ADR-0013: only owners enable writes. But
the projects, child projects and asset types of a workspace that has write tools, and the projects, asset types and end date of
a grant that has them, were an administrator's to widen: adding `Scope:3` to a write-enabled workspace allowed writes there
(reproduced through the API: the `PATCH` answered 200 and the stored workspace listed the added project). The guards now compare the change with the stored record and ask for an owner with a recent
sign-in only when it widens (a list is a set, no policy equals empty lists, narrowing and unrelated edits stay with
administrators, so the panel's forms keep working). Lesson L-237.

### Low

- **L1 — Pass-through needed no recent sign-in** — **fixed.** An owner with a stale session could make a workspace serve
  anyone holding a token for its instance. `credentialSource: 'passthrough'` now needs the recent sign-in, on create and update;
  going back to `stored` needs nothing.
- **L2 — A stale session could mint a standing device token** — **fixed.** A cookie older than 10 minutes could issue a token
  that never expires, surviving the session, sign-out and the user's next password change. A token past the 90-day default or
  `never` needs a recent sign-in (owners, admins and members alike; the break-glass token is exempt). Ordinary tokens stay
  frictionless (D-58). Lesson L-236.
- **L3 — A token could be issued while its grant moved to a personal token** — **fixed.** An admin may issue on a grant that
  uses the shared credential; if the member pointed the grant at their own token between the guard's check and the insert, the
  new token (missed by the switch's revocation) acted as the member in Agility. The guard now looks at the grant again once the
  token exists and revokes it, answering 409, when the grant moved to someone else's personal token (reproduced
  deterministically by switching inside the insert). Lesson L-239.
- **L4 — A late validation answer could vouch for a replaced token** — **fixed, narrowed.** A validation in flight when a token
  was replaced finished afterwards and marked the new, never-checked token `valid` with the old token's member (reproduced:
  the new token was `invalid`, the stored status ended `valid`). The answer is dropped when the sealed token changed while Agility
  was answering. A few milliseconds between the re-read and the write remain; a storage compare-and-swap closes them (task
  P4-37).
- **L5 — Audit rows did not say what changed** — **fixed.** `user.update` said `fields: ["role"]`: a promotion to owner looked
  like a demotion; a workspace row did not say which project or tool was added; `token.issue` did not name the token, so a tool
  call (which carries the token id) could not be traced back to who issued it, which also hid an administrator issuing on
  someone else's grant. Rows now carry the role (and the previous one), project and tool lists, write switches, the token id and
  end, the instance host (and the previous one, never a path or query) and the owner of a personal credential; names, emails
  and labels stay out (checked in the test). Lesson L-238.
- **L6 — The admin API buffered a whole body before checking its cap** — **fixed.** Any signed-in member could stream megabytes
  at a `POST` and have them read into memory (and cloned) before the 413. The body is read at most 64 KiB deep and cancelled
  there. (Cancelling a `clone()`'s reader must not be awaited: its promise waits for the other branch.)

### Accepted, as decisions and tasks

| Id | Severity | What | Reason | Where |
|---|---|---|---|---|
| A1 | medium | An administrator can add an instance at a new origin and ask members to enter their token there | ADR-0008 gives administrators instances; members see the address, the probe must pass, every add is audited with its host. Owner-only creation needs a new ADR | D-55, task P4-34 |
| A2 | low | An unused setup link cannot be listed or revoked | default one hour, single use, rare | D-56, task P4-35 |
| A3 | low | Admin audit rows are written after the change, best effort | an audit outage must not lock out incident response | D-57, task P4-36 |
| A4 | low | An old session can still issue ordinary tokens (up to 90 days) and do administrator work | frictionless connects; standing credentials are guarded | D-58 |
| A5 | info | Re-authentication at Google and GitHub is only as strong as the provider's prompt | existing decision | D-34 |
| A6 | info | On http loopback (development only) the session cookie is `ab_session`, not `__Host-`, so another local port could plant one | `serve` refuses plain http for any other host | documented in the admin access guide |
| A7 | info | Admins see a generic "not allowed" notice when widening a write-enabled workspace in the panel | the API is the boundary; the guide says so | admin guide |
| A8 | info | Admins can issue device tokens on any grant on a shared credential (attribution to that grant's user) | admins manage grants; now traceable by token id (L5) | admin guide |

## Checked and sound

- **One set of guards for every writer** (API, CLI, panel): the CLI is the same admin API in process; the panel changes things
  only through `callAdmin` with the viewer's session and CSRF token, and only after `kit.form` checked the form. No writer
  imports the raw services.
- **Roles and sessions**: read from the user row on every request; a disabled user's cookie fails, the row is deleted and
  enabling again revives nothing; a role change ends the sessions; sign-in rotates (a planted cookie dies), a cookie named twice is
  none, 20 per user, idle 30 minutes and 12 hours absolute.
- **CSRF and cross-origin**: unsafe methods need `Sec-Fetch-Site: same-origin`, `Origin` equal to the public origin and the
  session's token (a bad bearer never falls back to a cookie); reads accept only same-origin, `none` or a top-level navigation;
  an `AB_ALLOWED_ORIGINS` origin gets CORS but cannot change anything with the session; the CSV export refuses cross-site
  navigations; GET changes nothing (the one-time handles are bounded).
- **Redirects**: `next` is parsed and then checked as a local path (and again before the `Location` header), `/auth/reauth`
  returns through the same check, hostile ids never reach a `Location`.
- **Identity**: one identity per user bound by compare-and-set; an email bound to another identity is refused; an unverified or
  non-ASCII email is refused; setup links are single use under parallel completion and consumed before the user decision;
  a re-authentication creates and binds nobody; an identity-provider account with a matching email can claim only a row that is
  still unbound (decision D-46 documents the window after an unbind).
- **Mass assignment and ids**: every body is a strict schema (11 probes in `p4-review-writers`); another person's credential,
  grant or token answers 404 with the same body as a missing one, for owners and admins on *My access* too.
- **Writes stay off**: no path sets a write policy, write tools or pass-through without an owner (and now a recent sign-in);
  the resolver still needs the server switch, the workspace and the grant naming the tool and a personal credential.
- **Credentials**: never returned (hint only), `tls`/origin immutable while credentials live (trigger), the default credential is
  shared and of the workspace's instance (trigger, memory and SQL), a personal credential serves only its owner's grant.
- **Audit and errors**: no token, subject, email, code, path or query in any row or log line in the paths tried; storage and
  upstream errors are mapped to fixed messages; unexpected errors are `internal` with no detail.
- **Operator tools**: `cf:setup --sign-in` sends client secrets on stdin only; `cf:migrate` and the master-key commands need the
  database and the key (outside the authorization model by design).

## Not done

- A run against real identity providers and a real browser (owner step; P4-08's jobs ran against the local fakes).
- A load or timing test of the admin API's constant-time claims beyond the existing unit tests.
- The panel does not yet explain to an administrator *why* a widening was refused (a generic notice), and does not lock the
  project fields on a write-enabled workspace the way it locks the tool list.

## Go / no-go for P4-11

**Go.** The consolidated Phase 4 review can start from this document. The owner's answers to D-55 … D-58 can follow; each is
implemented as its recommended default.
