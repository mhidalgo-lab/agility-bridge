# Admin access: sessions, roles and re-authentication

> How people use the admin side of agility-bridge once they have signed in ([sign-in providers](identity-providers.md)):
> the browser session, the panel at `/admin`, who may do what, the extra sign-in that high-impact changes need, and how to
> end sessions. The [admin guide](admin-guide.md) is the starting page (role matrix, everyday tasks, troubleshooting). The
> panel's screens, member self-service, the connect page, the audit viewer and usage statistics are in the
> [admin panel guide](admin-panel.md), and everything is also in the [admin API](../reference/admin-api.md) and the CLI.
>
> Verification: tested against local fake providers and in-process requests, on Node and in workerd, and a real Chromium
> drives the panel end to end over http and https (P4-08, `pnpm test:e2e`). A sign-in with a real provider application has
> not been run yet ([pending decisions](../pending-decisions/phase-4.md)).

## The panel

Sign-in lands on `/admin`. The panel is server-rendered pages without scripts that matter (one small optional script
adds buttons that only help), a strict content security policy, and a layout that works on a phone (320 px wide). It
shows what the admin API shows you and changes things only by calling the admin API as you, so the roles, the
re-authentication rule and the audit rows are exactly those of the API (`via: api`).

| Page | Who | What it does |
|---|---|---|
| `/admin` | everyone signed in | Your session (email, role, expiry), sign-out buttons; admins also see the first users |
| `/admin/account` | everyone signed in | Your details; *End all my sessions* (any role); owners can change their display name |
| `/admin/instances`, `/credentials`, `/workspaces`, `/grants`, `/users` | owners and admins | The management screens ([admin panel guide](admin-panel.md)); members get a 403 page |

Anyone who is not signed in is sent to `/auth/login?next=<page>` for every `/admin` address; signed-in people get a
404 page for an address that does not exist. A change form that is refused (missing or wrong CSRF token, another site,
the wrong content type, too large, a role that may not use it) changes nothing and writes an `admin.forbidden` row.
When a change needs a recent sign-in (see below) the page says so and offers **Sign in again**; after it, repeat the
change. `/auth/account` still works and leads to `/admin/account`.

## Two ways in

| | Who | How it authenticates | CSRF token |
|---|---|---|---|
| **Browser session** | People: owners, admins, members | The `__Host-ab_session` cookie set at sign-in | Required on every `POST`, `PATCH` and `DELETE` |
| **Break-glass admin token** | Automation and recovery | `Authorization: Bearer ab_admin_…` (`AB_ADMIN_TOKEN_FILE`) | Not needed (no cookie is involved) |

A request that carries an `Authorization` header is judged as a token only: a wrong token is a `401` even if a valid
session cookie came with it. The admin API exists when sign-in is configured, when the admin token is set, or both
(`404` otherwise).

## The session

- Sign-in creates a session in the server's database (never in memory, so every Worker isolate or replica sees a sign-out
  at once). The browser gets `<user id>.<random secret>`; the database keeps only a **SHA-256 of the secret**, so a copy
  of the database is not a session.
- The cookie is `__Host-ab_session` (`ab_session` on `http://localhost`), `Secure`, `HttpOnly`, `SameSite=Lax`,
  `Path=/`, no `Domain`. `Lax` rather than `Strict` because sign-in ends in a redirect from the provider; changes are
  protected by the CSRF token and the origin checks, not by the cookie attribute. On `http://localhost` (trials on your own
  machine; `serve` refuses plain http for any other address) browsers do not allow the `__Host-` prefix, and cookies are not
  separated by port, so another program on another local port could plant a session cookie: use https for anything shared.
- A session ends after **30 idle minutes** or **12 hours** in all, whichever comes first; activity never extends the 12
  hours (`AB_SESSION_IDLE_MINUTES`, `AB_SESSION_MAX_HOURS`).
- Every sign-in starts a **new** session and ends the one the browser presented (so a cookie planted before sign-in is
  worthless). A user holds at most **20** sessions (`AB_SESSION_MAX_PER_USER`); the 21st sign-in ends the oldest.
- The role is read from the user's row on **every request**, never kept in the session. A disabled user loses access on
  the next request, and the session is deleted so enabling the user again does not bring it back. Changing a role or
  disabling a user also ends that user's sessions.

## Roles

| | Member | Admin | Owner |
|---|---|---|---|
| See and use their own credentials, grants and tokens ("My access" in the panel: add, check, replace, revoke and delete their personal Agility token, choose it on their grants, issue and revoke their device tokens) | yes | yes | yes |
| Manage instances, shared credentials, workspaces, grants, members | no | yes | yes |
| Create, promote, demote, disable or end the sessions of **admins and owners** | no | no | yes |
| Enable write tools and write policies, pass-through workspaces, master-key versions, setup links, instance origin changes, an instance's CA file | no | no | yes |
| Add projects or asset types to a workspace or grant that has write tools, or extend such a grant | no | no | yes |
| Demote or disable the last active owner | never | never | never |
| Read the audit log and usage statistics | own rows only, no statistics | everything | everything |

The rules live in the guards every writer shares (API, command line), not in the session; a session only says who is
asking. The break-glass token acts as an owner, except on `/me/*` (it is nobody there).

**Members' own access.** The API routes `/credentials`, `/grants/{id}/tokens` and `/tokens/{id}/revoke` already let a member
work on their own records only (another person's or a shared credential, and a grant that is not theirs, answer `404`), and
P4-07 adds `DELETE /credentials/{id}` for their own personal credential, `GET /me/grants`, `POST
/me/grants/{id}/credential` and `GET /me/audit`. A member stores a personal token only for an instance they have a live
grant on; at most 10 personal credentials per person and 20 live device tokens per grant. See the [admin panel
guide](admin-panel.md#my-access-every-role).

## Re-authentication

These changes need a sign-in from the **last 10 minutes** (an old session is fine for everything else):

- changing an instance's origin or TLS trust; retiring a master-key version; creating an owner setup link;
- creating an owner or admin, changing the role of an owner or admin or promoting a member, disabling an owner or admin;
- replacing a credential's token;
- enabling write tools or a write policy (workspaces, grants), and adding projects, asset types or a later end date to a
  workspace or grant that already has write tools (the owners decide where writes may land);
- making a workspace pass-through, or setting an instance's CA file when adding it;
- issuing a device token that lasts longer than 90 days (or never expires): a token is a standing credential, so a stolen
  older session cannot mint one that outlives it. Ordinary tokens (up to 90 days, the default) need nothing extra.

Without it the API answers `403` with the error code `reauth_required`. Send the browser to
`/auth/reauth?next=<path to return to>`: it signs the same user in again at the same provider (OIDC providers are asked
to prompt for credentials again), then returns to `next` with a fresh session. It cannot be used to become someone else:
the sign-in must be the identity already bound to the signed-in user, and it never creates or binds a user. Google and
GitHub do not report when the user authenticated, so for them the provider's own prompt is the only evidence; with
Cloudflare Access the assertion must have been issued in the last 10 minutes (sign out of Access and in again if not).
The break-glass token is exempt.

## Signing out and ending sessions

- **Sign out**: every panel page has *Sign out* in its footer, and the overview has *Sign out everywhere*. They are
  `POST /auth/logout` forms with the CSRF token; a `GET` does nothing. The server deletes the session, clears the cookie
  and sends `Clear-Site-Data: "cookies"`.
- **Careful**: `"cookies"` clears the cookies of the whole registered domain and its subdomains (a sign-out at
  `mcp.example.com` also signs the user out of `wiki.example.com`). If the server shares a domain with other
  applications, set `AB_LOGOUT_CLEAR_SITE_DATA=off`: the session cookie is still cleared and deleted on the server.
- **End someone's sessions**: yourself (any role); an owner anyone; an admin members only (the break-glass token anyone):

<!-- doc-test -->
```sh
npx -y agility-bridge user end-sessions --help
```

  or `POST /api/admin/v1/users/{id}/sessions/revoke` (needs the CSRF token with a session).

- **Move someone to another provider**: owners only (the break-glass token counts), a recent sign-in, never your own account
  through a session, and a confirmation that repeats the user's email. It ends the user's sessions and is audited as
  `user.unbind`; details in [identity providers](identity-providers.md#moving-a-user-to-another-provider).

## Using the admin API with a session

Scripts should use the break-glass token. A browser (or a tool driving one) that holds a session first reads
`GET /api/admin/v1/session`, which returns the user, the role, whether the sign-in is recent, the expiry and the
`csrfToken`, then sends that token as `X-CSRF-Token` on every `POST`, `PATCH` and `DELETE`:

```sh
# Reads need only the cookie; a change needs the cookie, the token, and an Origin equal to AB_PUBLIC_URL.
curl -s --cookie "__Host-ab_session=$SESSION" https://bridge.example.com/api/admin/v1/session
curl -s --cookie "__Host-ab_session=$SESSION" -H "X-CSRF-Token: $CSRF" -H "Origin: https://bridge.example.com" \
  -H "Content-Type: application/json" -d '{"email":"ann@example.com","role":"member"}' \
  https://bridge.example.com/api/admin/v1/users
```

A change is refused (`403`, an audit row `admin.forbidden`) when the token is missing or wrong, when `Origin` is not the
public origin (or is `null`), or when the browser says the request is cross-site (`Sec-Fetch-Site`). Reads are refused
when they are cross-site and not a page navigation. Nothing happens on a refusal.

## Audit

`session.create` (sign-in or re-authentication, whether it rotated a session, how many were evicted), `session.revoke`
(sign-out), `session.revoke_all` (sign-out everywhere, role change, disable, end-sessions, unbind, with the reason) and
`admin.forbidden` (reason `csrf`, `cross_site`, `origin_mismatch`, `origin_missing`, and `role` for a panel form your role may not use) are recorded as admin rows. A session
is named by a short hash prefix; cookies, secrets and CSRF tokens never reach the log or the audit table.
