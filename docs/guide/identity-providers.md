# Sign-in providers and the first owner

> Phase 4 (P4-01): who may sign in to the admin side of agility-bridge, and how the first owner is created. A finished
> sign-in starts a browser session ([admin access](admin-access.md): cookie, roles, CSRF, re-authentication) and lands
> in the admin panel (`/admin`, P4-03; its screens follow in P4-04 and later), and day-to-day administration is the
> [admin API](../reference/admin-api.md) and the [management commands](cli.md).
>
> Status of verification: every flow below is tested against **local fake providers**. A sign-in with a real Google,
> GitHub, Cloudflare Access or OIDC application has not been run yet; the checklist is in
> [pending decisions](../pending-decisions/phase-4.md). Provider facts and sources:
> [RESEARCH.md §9](../RESEARCH.md#9-admin-sign-in-providers-p4-01).

## How it works

- You register agility-bridge as an application at one or more providers: **Google**, **GitHub**,
  **Cloudflare Access** or any **OpenID Connect** provider (Microsoft Entra ID, Okta, Keycloak, ...). The server never
  stores passwords.
- A user's identity is the pair `(provider, subject)`: the provider's stable account id, never the email address and
  never a GitHub login name. One user row has at most one identity.
- **Nobody gets in by default.** A sign-in succeeds only when
  1. the identity is already bound to a user (they signed in before), or
  2. its **verified** email matches a user an owner or admin created and that has no identity yet (the identity is then
     bound to that user), or
  3. the email, its domain or the GitHub organization is on an allowlist **and** auto-provisioning is on (the new user
     gets the role `member` or `admin`, never `owner`), or
  4. the sign-in came through a one-time **setup link**, which makes that identity an owner.
- An email already bound to another identity is refused (`identity_conflict`): the same address at a second provider
  never silently links to an existing account. Disabled users are refused. Only plain ASCII email addresses are
  accepted from a provider.
- Each provider's answer is checked: the signature against the provider's keys, issuer, audience, expiry, `nonce`,
  PKCE, and a **verified** email (GitHub: the primary address, verified). Calls to a provider have a timeout, follow no
  redirects and are size-capped. On Node they refuse private, loopback and link-local addresses (see
  `AB_IDENTITY_PRIVATE_ADDRESSES`); Workers cannot reach them anyway.

## Settings

Set them in the environment of `agility-bridge serve`, or as Worker variables and secrets. Client secrets are never
flags and never tool arguments. With none of the provider settings present the `/auth/*` routes answer `404`.
A half-configured provider, or a bad value, stops the server at start with a message naming the variable (never the
value).

| Setting | Default | Meaning |
|---|---|---|
| `AB_PUBLIC_URL` | -- (required with a provider) | The origin browsers use, e.g. `https://bridge.example.com` (`http://localhost:8787` is accepted for local use). Redirect URIs are built from it, never from the `Host` header |
| `AB_GOOGLE_CLIENT_ID`, `AB_GOOGLE_CLIENT_SECRET` | unset | Google sign-in. Node: `AB_GOOGLE_CLIENT_SECRET_FILE` reads the secret from a `0600` file instead |
| `AB_GOOGLE_HOSTED_DOMAIN` | unset | Only accounts of this Google Workspace domain (`example.com`); the signed `hd` claim is checked, not only the request hint |
| `AB_GITHUB_CLIENT_ID`, `AB_GITHUB_CLIENT_SECRET` | unset | GitHub sign-in (an OAuth app); `AB_GITHUB_CLIENT_SECRET_FILE` on Node |
| `AB_OIDC_ISSUER`, `AB_OIDC_CLIENT_ID`, `AB_OIDC_CLIENT_SECRET` | unset | Any OpenID Connect provider by discovery; the issuer is the exact string the provider reports (https; http only for a loopback test provider). `AB_OIDC_CLIENT_SECRET_FILE` on Node |
| `AB_OIDC_NAME`, `AB_OIDC_LABEL`, `AB_OIDC_SCOPES` | `oidc`, `Single sign-on`, `openid email profile` | The route id (`oidc` or `oidc-<name>`), the button text, and the scopes (must include `openid`) |
| `AB_CF_ACCESS_TEAM`, `AB_CF_ACCESS_AUD` | unset | Cloudflare Access: the Zero Trust team name and the application's Application Audience (AUD) tag |
| `AB_LOGIN_ALLOW_EMAILS`, `AB_LOGIN_ALLOW_DOMAINS`, `AB_LOGIN_ALLOW_GITHUB_ORGS` | empty | Allowlists (comma-separated). A domain is exact: `example.com` does not admit `sub.example.com`. A GitHub organization needs an *active* membership |
| `AB_LOGIN_AUTO_PROVISION` | `off` | `member` or `admin`: create a user for an allowlisted identity on its first sign-in. With `off`, an allowlist alone admits nobody new (the start-up log says so) |
| `AB_RATE_LIMIT_SIGN_IN` | `60` | Requests to the sign-in routes per client address per 5 minutes (each start writes a row and may call the provider). On Workers the count is per isolate |
| `AB_IDENTITY_PRIVATE_ADDRESSES` | `refuse` | Node only. `allow` lets sign-in reach a provider on a private network (an internal Keycloak) or on loopback (a local test provider) |

## The first owner

An owner is needed before anything can be delegated. Create a one-time **setup link** with the break-glass admin
token (the server must have sign-in configured):

```sh
# Against a running server: AB_ADMIN_URL and the admin token (AB_ADMIN_TOKEN or AB_ADMIN_TOKEN_FILE)
export AB_ADMIN_URL=https://bridge.example.com
agility-bridge setup-link --ttl-minutes 30

# Or on the machine that holds the database, with the server's environment (writes to the local database)
agility-bridge setup-link
```

The same through the admin API:

```sh
curl -s -X POST "$AB_ADMIN_URL/api/admin/v1/setup-links" \
  -H "authorization: Bearer $AB_ADMIN_TOKEN" -H 'content-type: application/json' -d '{"ttlMinutes":30}'
```

Both print `{"id": …, "url": "https://bridge.example.com/auth/setup#ab_setup_…", "expiresAt": …}`. Open the `url` in a
browser and choose a provider. Then:

- The code sits in the URL **fragment** (`#…`): browsers never send it to a server, so it is in no access log, proxy
  log or `Referer`. A small script served by the app moves it into the form, which sends it in a POST body; without
  scripts, paste it into the field. Do not put it in a chat history or a ticket.
- It works **once**, expires after the lifetime you chose (60 minutes by default, 1 minute to 7 days), is stored only as
  a hash, and always means *owner*: whoever signs in with it becomes an owner, so share it with nobody. A sign-in that is
  refused after the link was accepted (a disabled user, an identity conflict) uses it up: issue another.
- Only an owner (or the break-glass token) can issue one; the audit log records who did (`setup_link.create`), never the
  code.

If the email of the person already exists as a user, they are promoted to owner and bound to the identity; the role they
had is recorded in the audit row. After the first owner exists, create further users with
`agility-bridge user add` or let people in through an allowlist.

## Create the applications

Redirect URIs are exact, and built from `AB_PUBLIC_URL`:

| Provider | Redirect URI |
|---|---|
| Google | `<AB_PUBLIC_URL>/auth/callback/google` |
| GitHub | `<AB_PUBLIC_URL>/auth/callback/github` |
| OIDC | `<AB_PUBLIC_URL>/auth/callback/oidc` (or `oidc-<name>` when you set `AB_OIDC_NAME`) |
| Cloudflare Access | none: the application protects `<AB_PUBLIC_URL>/auth/cf-access` |

### Google

1. Google Cloud console, *APIs & Services*, *Credentials*, *Create credentials*, *OAuth client ID*, type *Web
   application*.
2. Authorized redirect URI: the Google row above. Copy the client id and secret into `AB_GOOGLE_CLIENT_ID` and
   `AB_GOOGLE_CLIENT_SECRET`.
3. For a company: set `AB_GOOGLE_HOSTED_DOMAIN=example.com`; accounts outside the Workspace are refused even if a user
   removes the hint from the URL.

### GitHub

1. GitHub, *Settings*, *Developer settings*, *OAuth Apps*, *New OAuth App* (an organization can own one too).
2. Authorization callback URL: the GitHub row above. Generate a client secret and set `AB_GITHUB_CLIENT_ID` and
   `AB_GITHUB_CLIENT_SECRET`.
3. The server asks for `read:user user:email` (and `read:org` when `AB_LOGIN_ALLOW_GITHUB_ORGS` is set). An organization
   that restricts third-party applications must approve the app, or its members will look like non-members. The
   access token is revoked right after the lookup; it is never stored.

### Any OpenID Connect provider

1. Register a *confidential web application* with the authorization code flow, the redirect URI above and the scopes
   `openid email profile`.
2. Set `AB_OIDC_ISSUER` to the issuer exactly as the provider's discovery document reports it (the server compares it
   byte for byte; a trailing slash matters), plus the client id and secret.
3. The provider must put a verified email in the ID token or its userinfo answer (`email_verified: true`); otherwise
   sign-in is refused.

### Cloudflare Access

1. Zero Trust, *Access*, *Applications*, *Add an application*, *Self-hosted*, with the hostname of `AB_PUBLIC_URL` and the
   path `/auth/cf-access`; add a policy that lists who may sign in. Leave the rest of the site (the MCP endpoints, which
   use device tokens) outside Access.
2. Copy the application's *Application Audience (AUD) tag* into `AB_CF_ACCESS_AUD` and your team name (the part before
   `.cloudflareaccess.com`) into `AB_CF_ACCESS_TEAM`.
3. Visiting `/auth/login` then offers *Cloudflare Access*. The server trusts only a header it has verified against your
   team's keys, issuer and AUD tag; the `CF_Authorization` cookie is ignored, and service tokens (no email) are refused.

## Let people in

| Goal | Settings |
|---|---|
| Only people an admin added | none: create users with `agility-bridge user add`; they sign in once and are bound |
| Everyone at the company, as members | `AB_LOGIN_ALLOW_DOMAINS=example.com` and `AB_LOGIN_AUTO_PROVISION=member` (with Google, add `AB_GOOGLE_HOSTED_DOMAIN`: a domain match alone trusts the provider's verified email) |
| Members of a GitHub organization | `AB_LOGIN_ALLOW_GITHUB_ORGS=acme` and `AB_LOGIN_AUTO_PROVISION=member` |
| A few named people | `AB_LOGIN_ALLOW_EMAILS=ann@example.com,bob@example.com` and `AB_LOGIN_AUTO_PROVISION=member` |

`AB_LOGIN_AUTO_PROVISION=admin` makes every allowlisted identity an administrator on its first sign-in; start-up warns.
Owners are made only through a setup link or by another owner.

## Docker, systemd and Workers

- **Node and Docker:** put the secrets in files (`chmod 600`, outside the data directory) and point
  `AB_GOOGLE_CLIENT_SECRET_FILE`, `AB_GITHUB_CLIENT_SECRET_FILE` or `AB_OIDC_CLIENT_SECRET_FILE` at them (a Docker
  secret at `/run/secrets/...` works); setting both forms is refused.
- **Cloudflare Workers:** client ids, the issuer, the allowlists and `AB_PUBLIC_URL` are variables; the three client
  secrets are Worker **secrets** (`wrangler secret put`, or the dashboard), never `vars`. `pnpm cf:setup --sign-in` asks
  for all of it and sets the secrets through stdin ([deploy guide](cloudflare-deploy.md#sign-in-settings)); it validates
  the values with the server's own parser and prints the callback URLs to register. The setup link is issued by the
  Worker's admin API and works across isolates, because the transaction and the link live in D1.

## When sign-in fails

The browser sees one generic page and a request id. The audit log (`agility-bridge audit tail --kind auth`) has the
reason and a keyed hash of the identity, never the email, subject, code or token:

| Reason | Meaning |
|---|---|
| `not_allowed` | No user for this identity, and no allowlist entry matches (or the email is unverified) |
| `not_provisioned` | Allowlisted, but `AB_LOGIN_AUTO_PROVISION=off` and no user exists: add the user, or turn it on |
| `identity_conflict` | The email belongs to a user bound to another provider account, or two first sign-ins raced |
| `user_disabled` | The user is disabled |
| `email_unverified`, `email_missing` | The provider did not vouch for an (ASCII) address; GitHub needs a verified primary email |
| `hd_mismatch` | The Google account is not in `AB_GOOGLE_HOSTED_DOMAIN` |
| `unknown_state`, `binding_mismatch`, `provider_mismatch`, `invalid_callback` | An expired, replayed or foreign sign-in (another browser, another provider): start again from `/auth/login` |
| `wrong_audience`, `wrong_issuer`, `nonce_mismatch`, `invalid_token`, `token_expired`, `issuer_mismatch` | The provider's answer failed a check: wrong client id, a lookalike issuer, a clock far off, or a forged token |
| `idp_unavailable`, `idp_error` | The provider could not be reached or refused the code |
| `setup_invalid` | The setup link is unknown, used or expired |
| `missing_assertion` | Cloudflare Access did not send its header: the request did not pass through the Access application |
