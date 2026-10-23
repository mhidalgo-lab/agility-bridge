# The admin panel: instances, credentials, workspaces, grants, device tokens and users

> Phase 4 (P4-04). What an owner or an admin can do in the browser, screen by screen, and what each role sees. Signing in,
> roles, re-authentication and sessions are in [admin access](admin-access.md); the panel's design rules for contributors
> are in [admin panel (developer guide)](../dev/admin-ui.md). Members use their own pages ("My access", P4-07), the audit
> viewer (P4-05) and the connect page with client snippets (P4-06) come next.
>
> Verification: every screen is tested against the real admin API, real sessions and the storage contract in-process, and
> one screen flow runs in workerd. No real browser has driven it yet (P4-08).

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
| Users | `/admin/users` | yes | yes | Who can sign in and as what; members for admins, everyone for owners |

Members get a 403 page on all of these. Lists show 25 rows a page (`?page=2`); the credential and grant lists can be
filtered by instance or workspace. Every address needs a signed-in browser; anyone else is sent to the sign-in page.

### Instances

The list shows each instance's name, address and status. An instance's page shows its address, certificate authority,
number prefixes (learned from Agility, shown but not edited here), its credentials and its workspaces.

- **Add** checks the address with a request that carries no token (it must answer like an Agility site) and stores it.
- **Rename**, **Disable** (no new credentials; nothing is revoked) and **Delete** (refused while a workspace or credential
  uses it). Disabling and deleting ask first.
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

### Users

Owners see and manage everyone; admins can add and manage **members** only (name, email, disable, end sessions) and see
owners and admins read-only.

- **Add** creates a user who can then sign in with that email through a configured provider. Adding an admin or owner needs
  an owner with a recent sign-in.
- **Role** (owners): changes it, ends that person's sessions, needs a recent sign-in.
- **Disable** ends their sessions and stops sign-in; there is no way to enable a user again from the panel. Their grants
  and device tokens stay until you revoke them on the grants page.
- **End their sessions** works for yourself (any role), anyone (owners) or members (admins); ending your own signs you out.
- The **last active owner** cannot be demoted or disabled. The page says "That would leave the server without an active
  owner" and changes nothing; make another person an owner first.

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
