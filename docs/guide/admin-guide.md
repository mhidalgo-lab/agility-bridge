# Admin guide: running agility-bridge for a team

> The page to start with once a remote server runs (`agility-bridge serve`, Docker or a Cloudflare Worker). It says who
> can do what, how people get in, how to set up a team where everyone brings their own Agility token, and what to do
> when something goes wrong. Everything is done in a browser, on a phone too; the same actions exist in the
> [admin API](../reference/admin-api.md) and the [command line](cli.md).
>
> Not running yet? Follow the [remote quickstart](quickstart-remote.md) first. Details live in the other guides, which
> this page links to: [sign-in providers](identity-providers.md) · [admin access](admin-access.md) (sessions, CSRF,
> re-authentication) · [admin panel](admin-panel.md) (every screen) · [access model](access-model.md) ·
> [device tokens](multi-device.md) · [client snippets](clients.md#remote-server-device-token) · [audit log](audit-log.md) ·
> [Cloudflare deploy](cloudflare-deploy.md) · [Cloudflare limits](cloudflare-limits.md).

## What you manage

| Thing | Meaning | Where in the panel |
|---|---|---|
| **User** | A person who can sign in, with a role | Users |
| **Instance** | An Agility site | Instances |
| **Credential** | An Agility token, encrypted at rest: *shared* (read-only, a service member's) or *personal* (acts as its person) | Credentials, and *My access* for personal ones |
| **Workspace** | One MCP address `/w/<slug>/mcp`: projects, tools, asset types, limits | Workspaces |
| **Grant** | Lets a person or a service use a workspace, with a credential and narrower tools and limits | Grants |
| **Device token** | What one device presents; revocable alone | A grant's page, and Device tokens |

Nobody gets more than Agility gives the member behind the token, and a workspace and a grant only narrow further
([access model](access-model.md)).

## Who can sign in

Signing in proves who someone is; it never decides whether they may use the server, and the default is **no**. Nobody gets
in unless (1) their provider account is already bound to a user, (2) their **verified** email matches a user an owner or
admin added, (3) an allowlist matches **and** `AB_LOGIN_AUTO_PROVISION` is `member` or `admin`, or (4) they came through a
one-time **setup link**, which makes them an owner. Details, the settings and a recipe per goal:
[sign-in providers](identity-providers.md#how-it-works) and [let people in](identity-providers.md#let-people-in).

- **An allowlist alone admits nobody**: with `AB_LOGIN_AUTO_PROVISION=off` (the default) only users you added can sign in
  (D-29; the server warns at start).
- Auto-provisioning never creates an owner. `admin` makes every allowlisted person an administrator: prefer `member`.
- A domain allowlist trusts that domain's mail system and the provider's "verified" flag; with a generic OIDC provider,
  which can assert any address, prefer adding users by hand. For Google add `AB_GOOGLE_HOSTED_DOMAIN`.
- One user has one provider account. An email that belongs to a user bound elsewhere is refused (`identity_conflict`).

## The first owner

Issue a setup link with the break-glass admin token (`agility-bridge setup-link`), open it and sign in: you are an owner.
The link works once and is stored only as a hash; keep it out of chats. The steps for Node and for Cloudflare are in the
[remote quickstart](quickstart-remote.md#2-become-the-first-owner); the rules are in
[identity providers](identity-providers.md#the-first-owner). Make a second owner soon (*Users*, *Add* with the role
`owner`, needs a recent sign-in), so losing one account never locks you out; the last active owner can never be demoted or
disabled.

## Who can do what

Three roles. Members use **My access** (their own tokens, grants and devices) and see their own audit rows; owners and
admins manage everything below; owners also hold the changes that move trust or money-like risk (origins, write tools,
pass-through, owner accounts, keys). The break-glass admin token acts as an owner, without a sign-in to renew.

`recent` means it needs a sign-in from the last 10 minutes ([re-authentication](#re-authentication)).

<!-- role-matrix -->
| Action | Member | Admin | Owner |
|---|---|---|---|
| Add a member | no | yes | yes |
| Add an admin or an owner | no | no | recent |
| Change a role | no | no | recent |
| Disable a member | no | yes | yes |
| Disable an admin | no | no | recent |
| Enable a disabled member | no | yes | yes |
| End a member's sessions | no | yes | yes |
| End an admin's sessions | no | no | yes |
| Move a user to another provider | no | no | recent |
| Add an instance | no | yes | yes |
| Add an instance with its own TLS trust | no | no | recent |
| Change an instance's origin | no | no | recent |
| Add a shared credential | no | yes | yes |
| Replace a shared credential's token | no | recent | recent |
| Create a workspace | no | yes | yes |
| Enable write settings on a workspace | no | no | recent |
| Make a workspace pass-through | no | no | recent |
| Widen the projects of a workspace that has write tools | no | no | recent |
| Create a grant | no | yes | yes |
| Grant write tools | no | no | recent |
| Widen a grant that has write tools | no | no | recent |
| Issue a device token that never expires | no | recent | recent |
| Issue a device token on someone else's grant | no | yes | yes |
| See every person's connected OAuth apps | no | yes | yes |
| Disconnect a member's connected OAuth app | no | yes | yes |
| Disconnect an admin's connected OAuth app | no | no | yes |
| See and revoke registered OAuth apps | no | no | yes |
| Create an owner setup link | no | no | recent |
| Retire a master-key version | no | no | recent |

This table is executable documentation: `scripts/test/role-matrix.test.ts` runs every row against the real guards, so a
guard that changes without this page (or the other way round) fails CI (L-133). More rules the guards enforce:

- **Members' own things.** Everyone, whatever the role, can add, check, replace, revoke and delete **their own** personal
  Agility token (up to 10), choose it on their grants, issue and revoke device tokens on their own grants (up to 20 live
  per grant), and read their own recent changes ([member self-service](admin-panel.md#my-access-every-role)). Someone
  else's record answers like a missing one (`404`), so existence is never revealed, for owners and admins too on **My access**.
- **Nobody uses another person's token.** A grant names a shared credential or its own person's personal one, and only that
  person issues device tokens on it (a device token acts as them in Agility). Switching a grant to a personal token revokes
  its existing device tokens.
- **Admins and owners.** Admins manage members only; owners manage everyone. Nobody can demote or disable the last active
  owner. Through a session you cannot move your own account to another provider.
- **Composite reports** (`sprint_health`, `standup_summary`, ...) read their sections through other tools. If you tick one without those tools, press **Check these tools** under the list: the form shows which sections would be skipped, and nothing is saved.
- **Write tools** are off by default, need an owner, a recent sign-in and an explicit name on both workspace and grant, and
  never apply to a shared or someone else's personal token ([access model](access-model.md#the-token-policy)). Once an
  owner has enabled them, the owners also decide where they may land: an administrator can narrow a workspace or grant that
  has write tools, rename it or change its limits, but adding projects, child projects or asset types, or a later end date,
  needs an owner with a recent sign-in.
- **A CA file is the owners'.** An instance's TLS trust (the CA file) decides whom stored member tokens are sent to, so setting
  it needs an owner with a recent sign-in, in the panel and through the API alike. Adding an instance without one stays with
  administrators ([decision D-55](../pending-decisions/phase-4.md)).
- **Long-lived device tokens.** A token that never expires, or lasts more than 90 days, needs a sign-in from the last 10
  minutes.

What the guards do not decide, because it is not a change to a record:

| Reading | Member | Admin | Owner |
|---|---|---|---|
| The management screens (instances to users, usage) | `403` page | yes | yes |
| The audit log | own rows only (the server filters, the address cannot widen it) | everything | everything |
| Usage statistics | no | yes | yes |

## A team where everyone brings their own token

Each person uses their own Agility token, so Agility's permissions and change history stay per person and nobody shares
a secret. You shape the access; members attach their tokens and create their device tokens.

1. **Create the workspace once**: *Instances*, add the instance; *Credentials*, add a shared (service member) token as the
   workspace's default, so a person without a token yet is read-only; *Workspaces*, create it with its projects. The
   workspace is the ceiling: no grant can exceed it.
2. **Add the people** (*Users*, *Add*, role `member`) or let an allowlist do it. Tell them the panel's address
   (`<public URL>/admin`); no email is sent.
3. **Give each person a grant** on the workspace; narrow tools, projects or limits if needed, add an expiry. Leave the
   credential on the workspace default for now. Members cannot create grants or widen them.
4. **Each member** signs in, opens **My access** and *adds their Agility token* (the page explains where to create it;
   it is checked, encrypted, and never shown again), then on their grant chooses *use my token* and creates a device token
   per device.
5. If a member's token stops working (Agility refuses it), only their grant stops; yours and everyone else's do not. The
   server revalidates tokens daily ([credential validation](access-model.md#credential-validation)).

## Everyday tasks

| Task | Where |
|---|---|
| Someone leaves | *Users*, open them, **Disable**: signs them out and stops sign-in. Their grants and device tokens stay until you revoke the grant (*Grants*), which stops all its devices |
| A device is lost | *Device tokens*, find it by person or grant, **Revoke** (the others keep working) |
| An Agility token leaked or was rotated | *Credentials*, open it, **Replace the token** (recent sign-in); revoke the old one in Agility |
| A user moves to another provider account | Owner: [Move to another provider](#moving-a-user-to-another-provider) |
| Who did what | *Audit log*: filter by time, kind, outcome, tool, workspace, user; **Download CSV** |
| What is used | *Usage*: calls, errors, denials, Agility requests and durations per tool, workspace, grant, user or day |
| Add a device quickly | *Grants*, the grant, **New device token**, then **Connect a client** |
| A workspace should stop | *Workspaces*, **Disable** (stops all access, keeps everything); **Delete** also removes its grants and device tokens |

## Re-authentication

Some changes need a sign-in from the last 10 minutes even in an older session: the `recent` cells above, plus origin,
credential replacement and write settings. Without it the API answers `403` with the code `reauth_required` and the panel
shows a page that says nothing was changed and offers **Sign in again**: do that with the same account (it signs the same
identity in again at the provider, asking for credentials where the provider supports it) and repeat the change. Nothing is
retried for you, and a token you typed is not kept. It cannot be used to become someone else. The admin token is exempt.
Details: [admin access](admin-access.md#re-authentication).

## Sessions and signing out

Sessions live in the database (a sign-out reaches every replica or Worker isolate at once), end after 30 idle minutes or 12
hours (`AB_SESSION_IDLE_MINUTES`, `AB_SESSION_MAX_HOURS`), and a person holds at most 20. The role is read on every
request, so a changed role or a disabled user takes effect on the next request. *Sign out* and *Sign out everywhere* are at the
bottom of every page; an owner ends anyone's sessions from their user page, an admin a member's, with
`agility-bridge user end-sessions <user-id>`. Ending sessions does not stop device tokens: disable the user or revoke the
grant for that. Details: [admin access](admin-access.md#the-session).

## Moving a user to another provider

When someone changes provider account they are locked out until an **owner** clears the binding (*Users*, the person,
**Move to another provider…**, or `agility-bridge user unbind <id> --confirm <email>`). It needs a recent sign-in and the
person's email typed again, ends their sessions, and leaves their role, tokens, grants and devices alone. **The next
verified sign-in whose email matches binds the account, at any configured provider**: that is the takeover risk, so
check with the person first and keep configured providers to ones whose email verification you trust. Not available on
your own account through a session (ask another owner). Full rules:
[identity providers](identity-providers.md#moving-a-user-to-another-provider).

## Member self-service

Every signed-in person has **My access** (`/admin/me`): their grants and which Agility token each uses, their personal
tokens (add, check, replace, revoke, delete), their device tokens (issue one per device, revoke), a **Connect a client**
page with snippets for their client, and their recent changes. Owners and admins see the same pages and manage other people
in the management screens. Full list: [admin panel](admin-panel.md#my-access-every-role).

## Audit and usage

The audit log records every tool call, refusal and administrative change, never a secret or a token, and stored queries have every literal value masked
([audit log](audit-log.md)). The panel lists it newest first with filters and a keyset-paged **Next page**, and exports the
newest 1,000 matching rows as CSV (cells that a spreadsheet could run as a formula are neutralised). **Usage** counts
`tool_call` rows over 24 hours, 7 days or 30 days and reads at most the newest 10,000 of the window; the page says when it
stopped. Both are also `GET /api/admin/v1/audit` and `/audit/stats`, and `agility-bridge audit tail`. Retention is
`AB_AUDIT_RETENTION_DAYS` (90). Details: [admin panel](admin-panel.md#audit-log-and-usage).

## The panel's security properties

What the panel does so you do not have to:

- **It is a client of the admin API.** Every change is the call you could have made yourself, with the same role rules,
  re-authentication rule and audit row (`via: api`); a button appears only where the API would allow it.
- **No secret is ever in a page.** An Agility token is typed once into a password field, encrypted at once and shown never
  again (a form with an error comes back without it); a device token is shown once, on the answer to the form that made it
  (`Cache-Control: no-store`), is not in a redirect or URL and is stored only as a hash; resending the form makes no second
  token.
- **Sessions**: `__Host-ab_session` cookie (`Secure`, `HttpOnly`, `SameSite=Lax`, no `Domain`; the database keeps only a
  hash), a new session at every sign-in, deleted on the server at sign-out.
- **Forged requests**: every change needs a CSRF token, the server's own `Origin`, and not a cross-site `Sec-Fetch-Site`;
  anything else changes nothing and writes an `admin.forbidden` row.
- **Pages**: server-rendered with every value escaped, a strict content security policy (no inline script, Trusted Types,
  no framing), plain-text rendering of everything that came from Agility or from people, and a layout that works at 320 px.
  A real browser checks all of this on every pull request that touches the panel, and an OWASP ZAP baseline scans it
  ([testing](../dev/testing.md#browser-e2e-and-zap-e2e-phase-4)).
- **Takeover guards**: the setup link carries its secret in the address fragment; the unbind needs an owner, a recent
  sign-in and a typed email; the last owner is protected.

What it does not do: it does not sign people out of the identity provider, it cannot revoke a provider's own session, and a
disabled user's device tokens keep working until you revoke their grants. Provider sign-in with real applications has not
yet been run by the project ([pending decisions](../pending-decisions/phase-4.md)).

## Troubleshooting

The panel's messages are fixed sentences ([list](admin-panel.md#messages-you-will-see)). The browser shows a generic page and a
request id when sign-in fails; the reason is in the audit log (`agility-bridge audit tail --kind auth`) and the table in
[identity providers](identity-providers.md#when-sign-in-fails).

| You see | Likely cause | What to do |
|---|---|---|
| `/auth/login` answers `404` | No sign-in provider is configured (the `/auth/*` routes are off), or `AB_PUBLIC_URL` is not set | Set a provider and `AB_PUBLIC_URL`, restart (`serve`) or `pnpm cf:setup --sign-in` (Worker) |
| Sign-in ends on a generic error page | The audit row says why: `not_allowed` (no user and no allowlist match), `not_provisioned` (allowlisted, auto-provisioning off), `identity_conflict`, `user_disabled`, `email_unverified`, `hd_mismatch`... | Add the user, turn provisioning on, or fix the provider; the full table is in [identity providers](identity-providers.md#when-sign-in-fails) |
| The provider says "redirect URI mismatch" | The registered address differs from `<public URL>/auth/callback/<provider>`, or the public URL changed | Register exactly that address; keep `AB_PUBLIC_URL` equal to what browsers use. `pnpm cf:setup --sign-in` prints the list |
| The setup link says it is invalid | Used, expired, or the sign-in after it was refused (that uses it up) | Make another with `agility-bridge setup-link` |
| `403` with `reauth_required`, or "Sign in again" | The change needs a sign-in from the last 10 minutes | **Sign in again** with the same account, then repeat the change ([re-authentication](#re-authentication)). With Cloudflare Access the assertion must be that fresh: sign out of Access and in again |
| `403` "Your role does not allow that" | The role cannot do it, or the role changed meanwhile | See the [matrix](#who-can-do-what); ask an owner |
| A form says "That form was already used" | A device token form was sent twice | No second token was made; revoke and issue again if you lost it |
| Signed out all the time, or a sign-in loops | The cookie is not kept or not sent: you opened the panel at an address other than `AB_PUBLIC_URL` (another host name, `127.0.0.1` for `localhost`, `http` for an `https` URL), a proxy drops `Set-Cookie`, or the clock is far off | Open the panel exactly at `AB_PUBLIC_URL`. The cookie is `__Host-ab_session` on https and `ab_session` on `http://localhost` |
| Signing out of the panel also signed you out of other sites | `Clear-Site-Data: "cookies"` clears the cookies of the whole registered domain, including its subdomains | If the server shares a domain with other applications, set `AB_LOGOUT_CLEAR_SITE_DATA=off`: the session cookie is still cleared and deleted on the server ([admin access](admin-access.md#signing-out-and-ending-sessions)) |
| Changes from a script with a session cookie fail with `403` | A change needs the CSRF token, an `Origin` equal to the public URL, and no cross-site fetch metadata | Use the admin token for scripts, or follow [using the admin API with a session](admin-access.md#using-the-admin-api-with-a-session) |
| The owner setup page does nothing after you choose the provider, with a content security policy message in the browser console | The setup form is answered with a redirect to the identity provider, and Chromium applies `form-action` to the redirects after a form post, so that one page has a policy **without** `form-action` (D-35, [L-195](../LESSONS-LEARNED.md)). A proxy or a Cloudflare Transform Rule that adds its own `Content-Security-Policy` header, or an extension that does, puts it back | Do not add a global `form-action` header in front of `/auth/setup`; Firefox and WebKit have not been run (D-44) |
| The panel is slow the first time on Cloudflare Free | The first request of a new isolate costs more CPU than 10 ms (D-27); warm pages cost 1 to 4 ms | Reload; or the Paid plan ([limits](cloudflare-limits.md#measured-cost)) |
| A device cannot reach the workspace | A revoked, expired or wrong-workspace token, a disabled user or grant, or Cloudflare bot protection challenging the client | [Device tokens](multi-device.md), and bot rules in [Cloudflare deploy](cloudflare-deploy.md#a-custom-domain); MCP errors: [troubleshooting](troubleshooting.md) |

Still stuck? The request id on the error page is in the server log and the audit row. Open an issue with the reason code and
the version (`npx -y agility-bridge --version`), never with a token, a setup link or Agility content.

## Settings that matter here

| Setting | Meaning |
|---|---|
| `AB_PUBLIC_URL` | The origin browsers use; required for sign-in |
| `AB_GOOGLE_*`, `AB_GITHUB_*`, `AB_OIDC_*`, `AB_CF_ACCESS_*` | Providers ([identity providers](identity-providers.md#settings)) |
| `AB_LOGIN_ALLOW_EMAILS`, `AB_LOGIN_ALLOW_DOMAINS`, `AB_LOGIN_ALLOW_GITHUB_ORGS`, `AB_LOGIN_AUTO_PROVISION` | Who may sign in without being added |
| `AB_SESSION_IDLE_MINUTES`, `AB_SESSION_MAX_HOURS`, `AB_SESSION_MAX_PER_USER` | Session lifetime and count |
| `AB_LOGOUT_CLEAR_SITE_DATA` | `cookies` (default) or `off` |
| `AB_ADMIN_TOKEN_FILE` / `AB_ADMIN_TOKEN` | The break-glass owner for the CLI and automation |
| `AB_AUDIT_RETENTION_DAYS` | How long audit rows are kept (90) |

All settings: [configuration](configuration.md#server-mode-agility-bridge-serve).
