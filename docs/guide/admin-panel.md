# The admin panel: instances, credentials, workspaces, grants, device tokens and users

> What an owner or an admin can do in the browser, screen by screen, and what each role sees; members' own pages ("My
> access"), the connect page with client snippets, the audit viewer and usage statistics are below. Start with the
> [admin guide](admin-guide.md) (who can do what, everyday tasks, troubleshooting) or the
> [remote quickstart](quickstart-remote.md). Signing in, roles, re-authentication and sessions are in
> [admin access](admin-access.md); the panel's design rules for contributors are in
> [admin panel (developer guide)](../dev/admin-ui.md).
>
> Verification: every screen is tested against the real admin API, real sessions and the storage contract in-process, and
> one screen flow runs in workerd. A real Chromium drives the panel end to end at 1280 px and 320 px (P4-08,
> `pnpm test:e2e`, [testing](../dev/testing.md#browser-e2e-and-zap-e2e-phase-4)), and an OWASP ZAP baseline scans it.

The panel is at `/admin` on `agility-bridge serve` and on the Cloudflare Worker. It works without scripts (one small
optional script adds a *Copy* button), fits a phone 320 px wide, and shows only what the **admin API** shows you: every
change is the API call you could have made yourself, with the same role rules, the same re-authentication rule and the
same audit row (`via: api`). A button appears only when the API would allow it for your role.

## The screens

| Menu | Address | Owner | Admin | What it does |
|---|---|---|---|---|
| Instances | `/admin/instances` | yes | yes | The Agility sites. Add, rename, disable, delete (only when nothing uses it). Origin and certificate-authority changes: owner only |
| Credentials | `/admin/credentials` | yes | yes | Agility access tokens: shared ones and your own personal one. Check, rename, replace the token, revoke, delete |
| Workspaces | `/admin/workspaces` | yes | yes | One MCP endpoint each: projects, tools, asset types, limits. Write settings and pass-through: owner only |
| Grants | `/admin/grants` | yes | yes | Who may use which workspace, with which credential, tools, projects, limits, rate and expiry; their device tokens |
| Device tokens | `/admin/tokens` | yes | yes | Every device token of every grant in one list, filtered by person or grant; revoke a lost device |
| Users | `/admin/users` | yes | yes | Who can sign in and as what; members for admins, everyone for owners |
| Audit log | `/admin/audit` | yes | yes | Every tool call, refusal and change, filtered and paged; **members see their own rows** here |
| Usage | `/admin/usage` | yes | yes | Calls, errors, denials, Agility requests and durations per tool, workspace, grant, user or day |

Members get a 403 page on all of these except the audit log. Lists show 25 rows a page (`?page=2`); the credential and grant lists can be
filtered by instance or workspace. Every address needs a signed-in browser; anyone else is sent to the sign-in page.

### Instances

The list shows each instance's name, address and status. An instance's page shows its address, certificate authority,
number prefixes, its credentials and its workspaces.

- **Add** checks the address with a request that carries no token (it must answer like an Agility site) and stores it.
- **Rename**, **Disable** (no new credentials; nothing is revoked) and **Delete** (refused while a workspace or credential
  uses it). Disabling and deleting ask first.
- **Edit the prefixes** (owners and admins): the letters before the dash in an Agility number, one `Type=PREFIX` per line (for
  example `Story=S`). A type name is letters, digits and underscores; a prefix is one to four capital letters. An empty box clears
  them. The same rules apply to the admin API and the CLI, and a line the rules refuse is shown beside the form with nothing
  saved. **They are stored but not yet applied**: number lookups still learn the prefixes from Agility (task P4-30).
- **Change the origin** (owners): stored Agility tokens are sent to this address, so changing it or the CA file
  **revokes every credential of the instance and every grant that used them**. The page says so with the number of
  credentials in use, requires ticking a box, and needs a sign-in from the last 10 minutes.

### Credentials

A credential is an Agility access token the server uses on behalf of a grant. **Shared** credentials are read-only for
everyone who uses them; a **personal** one acts as its person in Agility.

- You type a token into a password field, once. It is encrypted at once and never shown again: not in a page, a form that
  has an error, a message, a redirect, a cookie, the audit log or the logs. Only its last four characters are kept as a
  hint (`…ab12`). A form with an error comes back without the token: type it again.
- **Add** stores a shared token, or your own personal one. Nobody stores a personal token for someone else; members add
  theirs in "My access".
- **Check now** asks Agility who the token belongs to and which projects it reaches.
- **Replace the token** (needs a sign-in from the last 10 minutes): the credential counts as not checked until the new
  token has been checked. Only the owner of a personal credential can replace its token; admins and owners see no button
  for someone else's.
- **Revoke** is final. **Delete** only works for a credential no grant uses.

### Workspaces

A workspace is an endpoint `/w/<name>/mcp` that serves a set of Agility projects with its own tools, asset types and
limits. Creating one is two steps: choose the instance (it cannot change later), then fill in the form.

- **Projects** are written `Scope:1001` (or just the number), separated by commas; the instance's credentials' reachable
  projects are suggested. Nothing outside them is ever readable through the workspace.
- **Tools**: "every read tool" (including ones added later) or a list. Write tools are never part of "all".
- **Asset types** and **limits** (rows, fields, response size, time range, request budget per tool call, member emails,
  generic query tools): a blank field means the server default; grants can only narrow them.
- **Owner settings**: *Allow writes* and *Credential source* (pass-through). Owners only, with a recent sign-in. Admins do
  not see them and do not see write tools. When a workspace already enables write tools, an admin's edit leaves that list
  as it is and says why.
- **Disable** stops all access to the endpoint; **Delete** removes the workspace, its grants and their device tokens, after
  a confirmation that says how many grants go.

### Grants and device tokens

A grant gives a **person**, or a **service** (a named automation, read-only), access to a workspace. Creating one is two
steps (workspace, then form). Choose the credential (shared, or the person's own), the tools, the projects (all of the
workspace's, or some), asset types, limits, a rate and an expiry. A grant can only narrow its workspace; a value that
tries to widen it is stored and the grant's page says it has no effect. Write tools need an owner and a recent sign-in.

On a grant's page, **New device token** makes one token for one device (make one per laptop or phone, so a lost one can be
revoked alone). The page that follows shows the token **once**:

- It appears only on the answer to the form you submitted (`Cache-Control: no-store`). It is not in a redirect, a message
  or a URL, and it is not stored: only its hash is. If you lose it, revoke it and make another.
- **Reloading the page, the back button or sending the form again does not make a second token.** The form carries a
  single-use handle that the server takes before it creates anything; a re-sent form is answered with "already used".
- There is no button for a grant that uses **someone else's personal Agility token**: such a token would act as that
  person in Agility, so only they can issue device tokens on it. Revoked and expired grants offer none either.
- **Revoke** a token from the grant's page, after a confirmation. Revoking or deleting a grant stops all its tokens.
- **Find a lost device** on **Device tokens** (`/admin/tokens`, owners and admins): every token of every grant, newest first, 50 to
  a page (**Next page** follows the list by cursor, so tokens added or revoked meanwhile never repeat or skip an entry). Filter
  by person or by grant; each row shows the device name, the first characters of the token, the grant it belongs to, its status,
  when it was last used and when it expires, with **Revoke…** for live ones. Never a hash and never a token.

### Users

Owners see and manage everyone; admins can add and manage **members** only (name, email, disable, end sessions) and see
owners and admins read-only.

- **Add** creates a user who can then sign in with that email through a configured provider. Adding an admin or owner needs
  an owner with a recent sign-in.
- **Role** (owners): changes it, ends that person's sessions, needs a recent sign-in.
- **Disable** ends their sessions and stops sign-in. Their grants and device tokens stay until you revoke them on the grants page.
- **Enable…** (shown only for a disabled person you may manage: owners for anyone, admins for members) lets them sign in again
  with the role they had. It asks first, needs a recent sign-in for owners and admins, creates no session (they sign in
  themselves) and brings back every grant and device token that was not revoked, so check those first if you are unsure.
- **End their sessions** works for yourself (any role), anyone (owners) or members (admins); ending your own signs you out.
- **Move to another provider…** (owners only, for a person who is signed in with a provider, never your own page): clears their
  sign-in identity so the next verified sign-in with their email binds again, and ends their sessions. The page warns about the
  takeover risk and asks for the email again; it needs a recent sign-in. See
  [moving a user to another provider](identity-providers.md#moving-a-user-to-another-provider).
- The **last active owner** cannot be demoted or disabled. The page says "That would leave the server without an active
  owner" and changes nothing; make another person an owner first.

## My access (every role)

Everyone who signs in, members included, has **My access** in the menu (`/admin/me`). It shows only your own things; an
owner or an admin sees the same pages, not other people's, and manages other people's tokens and grants in the screens above.

- **My grants**: the workspaces an administrator gave you, which Agility token each one uses, and whether it is active.
  Administrators assign grants; you cannot create one or change which projects or tools it reaches.
- **My Agility tokens**: your personal tokens (up to 10). The page tells you how to create one on Agility's Applications
  page (profile menu, Applications, Add Application, copy the token once). Paste it into the password field; it is
  encrypted at once, checked against Agility, and never shown again: the page keeps only its last four characters. You can
  add a token only for an instance you have a grant on. If Agility refuses the token, it is kept but unusable and the
  page says so: replace it with a new one.
- **Check now**, **Rename**, **Replace the token** (needs a sign-in from the last 10 minutes), **Revoke** (final) and
  **Delete** (removes the encrypted token from the server; only when none of your grants uses it).
- **My grant**: choose which of your valid tokens the grant uses, or go back to the workspace default. Going back is
  allowed only while the grant uses one of *your* tokens: an administrator's choice of a shared token is theirs to change.
  Switching to a personal token revokes the device tokens already issued on that grant, so none keeps acting through a
  different token. Writes stay off: a personal token never enables write tools.
- **My devices**: device tokens on the grant (up to 20 live ones): issue one per device (shown once), revoke one.
- **Connect a client** (on the grant, also for owners and admins on any grant): the endpoint of the workspace and a copy-paste
  configuration for each client, see [Connect a client](#connect-a-client).
- **Connected apps** (only when [OAuth](oauth-phone.md) is on): the apps you allowed on the consent screen, with the
  name the app gave itself (not verified), the device name you typed, the workspace, where it sends its answers, when you
  connected it and when its access ends. **Disconnect** ends that app's access and refresh tokens at once; **Disconnect
  all apps** does it for every one. You see and disconnect only your own; administrators do not see these yet.
- **My recent changes**: your own last administrative changes (what and when, never a secret).

### Connect a client

On a grant's page (and on **My grant**), **Connect a client** shows the workspace's MCP endpoint, built from the server's
configured public address (`AB_PUBLIC_URL`), and one configuration per client: GitHub Copilot in VS Code, in JetBrains and
the Copilot CLI, Claude Code (command, PowerShell and `.mcp.json`), Cursor, Windsurf / Devin Desktop and the MCP Inspector
CLI. They are the snippets of the [client setup guide](clients.md#remote-server-device-token) with your workspace filled in.

- The page never contains a token: tokens are stored as hashes. Create one with **Create a device token**; the page that
  shows it once repeats the snippets, and puts the token into the one that cannot read it from a prompt or an environment
  variable (JetBrains). Reloading that page shows nothing.
- Most snippets read the token from a password prompt (VS Code) or from the `AGILITY_BRIDGE_TOKEN` environment variable, so
  it is never typed into a shell command line or committed into a project file.
- Only the person who holds a grant opens its page under **My access**; someone else's grant is a "not found" page, for owners
  and admins too. Owners and admins open any grant's page from the screens above.
- A revoked or expired grant and a disabled workspace are said so on the page, and a grant that cannot issue tokens offers
  no button.
- claude.ai, Claude Desktop connectors and Claude mobile need OAuth and are listed without a snippet.

### Audit log and usage

**Audit log** (`/admin/audit`) lists what the server recorded, newest first, 50 rows a page. Filters: time (last hour to
last 90 days, or everything retained; the default is 7 days), kind (`tool_call`, `write`, `auth`, `admin`), outcome (`ok`,
`error`, `denied`), an exact tool or action name, and, for owners and admins, workspace and user. **Next page** continues
after the last row you saw (a keyset cursor in the address), so new rows arriving while you read never repeat or skip a row,
and *Newest entries* returns to the top. A **member** sees only rows with their own user id: the server decides that, so
changing the address (`?user=…`) shows nothing more, and asking the API for another user is refused.

Every value in a row is shown as plain text, including tool names, error codes, target ids and the stored queries (every
literal value in a query is masked before it is stored; long ones are cut for display). Nothing secret is in the log
([audit log](audit-log.md)).

**Download CSV** exports the same filter as `audit-YYYY-MM-DD.csv`: the newest 1,000 matching rows (the response header
`X-Export-Truncated: 1000` appears when more matched; narrow the time range and export again). Every text cell is quoted,
and a cell a spreadsheet could run as a formula (it starts with `=`, `+`, `-`, `@`, a tab or a line break, or one of those
signs after spaces) gets a leading apostrophe. A link from another site to the CSV lands on the audit page instead of
downloading.

**Usage** (`/admin/usage`, owners and admins) counts `tool_call` rows over the last 24 hours, 7 days or 30 days, grouped by
tool, workspace, grant, user or UTC day: calls, errors (with the share of calls), denied, Agility requests, mean and
slowest time. Refused requests and administrative changes are not tool calls and are not counted. To stay inside the free
Cloudflare limits the statistics read at most the **newest 10,000 rows** of the window; when the window holds more, the page
says so and the numbers cover only the newest rows (choose a shorter window for exact figures).

Both pages call the admin API (`GET /api/admin/v1/audit`, `GET /api/admin/v1/audit/stats`), so the CLI
(`agility-bridge audit tail`) and scripts see the same rows with the same rules.

## When the page asks you to sign in again

A change that needs a recent sign-in (origin, replacing a token, write settings, owner and admin changes) answers with a
page that says nothing was changed and offers **Sign in again**. Do that with the same account, then make the change again
from the page it returns you to. Nothing is retried for you, and a token you typed is not kept: type it again.

## Messages you will see

Messages are fixed sentences; the panel does not show text the API or Agility sent, except a one-line validation message
(for example `name: must not be empty.`) beside the form that caused it, as plain text.

| Message | Meaning |
|---|---|
| Your role does not allow that | Your role cannot make this change. The button is hidden when the API would refuse it, so this means your role changed meanwhile, or the request was forged |
| That conflicts with the current state | Something else changed first, or the thing is in use (an instance with workspaces, a credential with grants) |
| That would leave the server without an active owner | The last-owner rule |
| That form was already used | A re-sent token form: no second token was made |
| The service is unavailable right now | Storage or Agility could not be reached; nothing changed |

Everything in the panel is also in the [admin API reference](../reference/admin-api.md) and the command line
([CLI](cli.md)).
