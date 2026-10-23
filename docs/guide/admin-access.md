# Admin access: sessions, roles and re-authentication

> Phase 4 (P4-02). How people use the admin side of agility-bridge once they have signed in
> ([sign-in providers](identity-providers.md)): the browser session, who may do what, the extra sign-in that
> high-impact changes need, and how to end sessions. The panel itself arrives with P4-03; until then the pages are
> `/auth/account` and the [admin API](../reference/admin-api.md).
>
> Verification: all of it is tested against local fake providers and in-process requests, on Node and in workerd. No
> real browser has driven it yet (the browser end-to-end task is P4-08).

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
  protected by the CSRF token and the origin checks, not by the cookie attribute.
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
| See and use their own credentials, grants and tokens | yes | yes | yes |
| Manage instances, shared credentials, workspaces, grants, members | no | yes | yes |
| Create, promote, demote, disable or end the sessions of **admins and owners** | no | no | yes |
| Enable write tools and write policies, pass-through workspaces, master-key versions, setup links, instance origin changes | no | no | yes |
| Demote or disable the last active owner | never | never | never |
| Read the audit log | no | yes | yes |

The rules live in the guards every writer shares (API, command line), not in the session; a session only says who is
asking. The break-glass token acts as an owner.

## Re-authentication

These changes need a sign-in from the **last 10 minutes** (an old session is fine for everything else):

- changing an instance's origin or TLS trust; retiring a master-key version; creating an owner setup link;
- creating an owner or admin, changing the role of an owner or admin or promoting a member, disabling an owner or admin;
- replacing a credential's token;
- enabling write tools or a write policy (workspaces, grants).

Without it the API answers `403` with the error code `reauth_required`. Send the browser to
`/auth/reauth?next=<path to return to>`: it signs the same user in again at the same provider (OIDC providers are asked
to prompt for credentials again), then returns to `next` with a fresh session. It cannot be used to become someone else:
the sign-in must be the identity already bound to the signed-in user, and it never creates or binds a user. Google and
GitHub do not report when the user authenticated, so for them the provider's own prompt is the only evidence; with
Cloudflare Access the assertion must have been issued in the last 10 minutes (sign out of Access and in again if not).
The break-glass token is exempt.

## Signing out and ending sessions

- **Sign out**: the account page (`/auth/account`) has two buttons, *Sign out* and *Sign out everywhere*. They are
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
(sign-out), `session.revoke_all` (sign-out everywhere, role change, disable, end-sessions, with the reason) and
`admin.forbidden` (reason `csrf`, `cross_site`, `origin_mismatch`, `origin_missing`) are recorded as admin rows. A session
is named by a short hash prefix; cookies, secrets and CSRF tokens never reach the log or the audit table.
