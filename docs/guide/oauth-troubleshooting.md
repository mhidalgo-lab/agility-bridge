# Troubleshooting OAuth

> For people connecting an app and for the operator who has to find out why it did not work. Setup:
> [operator guide](oauth-operator.md), [claude.ai and phone](oauth-phone.md), [IDEs and CLIs](oauth-ides.md). Rows in the
> **audit log** are named here; read them with `agility-bridge audit tail --kind auth` on Node, or on the admin panel's
> audit page ([audit log](audit-log.md)). The audit log never holds a token.

Find the step where it stopped:

| The app says or does | Look at |
|---|---|
| "Could not find the authorization server", "needs authentication" forever, no browser opens | [Discovery](#discovery) |
| The browser shows an error before the consent page, or `invalid_redirect_uri` | [Redirect problems](#redirect-problems) |
| The sign-in fails, or the consent page refuses | [Sign-in and consent](#sign-in-and-consent) |
| `429`, "too many requests", "registration refused" | [Registration caps and 429](#registration-caps-and-429) |
| Connected, but a tool answers "not found" | [Not found](#not-found-on-an-item-that-exists) |
| Was connected, now asks again | [Disconnect, reconnect and refresh](#disconnect-reconnect-and-refresh) |

## Discovery

An app that has no token calls the workspace address and expects a `401` that says where to sign in. Check each step from any
machine; no credentials are involved (these calls were run on 2026-10-27 against a real Worker, with a made-up workspace
name):

```sh
curl -si -X POST https://bridge.example.com/w/my-team/mcp -H 'Content-Type: application/json' -d '{}'
curl -s https://bridge.example.com/.well-known/oauth-protected-resource/w/my-team/mcp
curl -s https://bridge.example.com/.well-known/oauth-authorization-server
```

1. **The `401` challenge.** Expect `401` with
   `WWW-Authenticate: Bearer realm="agility-bridge", resource_metadata="https://bridge.example.com/.well-known/oauth-protected-resource/w/my-team/mcp", scope="mcp:read"`.
   A bare `WWW-Authenticate: Bearer` means OAuth is **off** on the running process (`AB_OAUTH` is not `on`; on a Worker, check
   the deployed variable and that the last deploy used the config that holds it, see the
   [operator guide](oauth-operator.md#cloudflare-worker)). The same `401` comes for an unknown, a disabled and a misspelt
   workspace: it never tells which.
2. **Protected resource metadata.** `{"resource": ".../w/my-team/mcp", "authorization_servers": [...]}`. It is the same for
   every workspace name of valid syntax (a made-up one gets the same document), so a `404` means the name has characters a
   workspace slug cannot have (lower case letters, digits and hyphens).
3. **Authorization server metadata.** `issuer` must equal the public address you gave people. If it names `127.0.0.1`,
   `workers.dev` or another host, `AB_PUBLIC_URL` is wrong: set it and approve the apps again (they were bound to the old
   issuer). `registration_endpoint` is missing when `AB_OAUTH_DCR=off`. `404` on both documents means OAuth is off.
4. **The Host allowlist.** The server answers only requests whose `Host` is its public host (and `AB_ALLOWED_HOSTS`). Any
   other host, such as an old `workers.dev` address after you moved to a custom domain, gets `403`. Point the app at the
   public address.
5. **Something in front.** A proxy, a firewall or an Access application on `/w/*`, `/oauth/*` or `/.well-known/*` answers with
   a login page or a redirect instead of these documents: take those paths out of it. Only the sign-in paths belong to
   Cloudflare Access ([identity providers](identity-providers.md#cloudflare-access)).
6. **Reachability.** claude.ai calls your server from the internet, over IPv4 and public HTTPS with a trusted certificate.
   A `curl` that works on your laptop does not prove that; test from outside your network.

## Redirect problems

An OAuth app tells the server where to send you back (the **redirect address**) and the server sends the code only there.

- **Private-use schemes are refused** (D-69). An address like `cursor://...` is dropped when the app registers; if nothing
  usable is left the registration fails with `invalid_redirect_uri` ("The client metadata is not acceptable."). Only `https`
  addresses and loopback `http` (`http://127.0.0.1:<port>/...`, `http://[::1]:<port>/...`) work. There is no workaround on
  your side: use a device token and tell us which client it was (task P5-15).
- **Loopback ports.** A client that listens on a random local port is fine: the port may differ from the registered one. The
  consent page then says the answer goes to a program on your own computer. If the browser ends at "connection refused" on
  `localhost`, the program is not waiting any more (you were too slow), or it runs on another machine: a remote shell cannot
  receive the answer, so start the sign-in again on the machine where the client runs.
- **The redirect host allowlist.** With `AB_OAUTH_DCR_REDIRECT_HOSTS` set, a dynamically registered app may redirect only to
  those `https` hosts; any other is refused at registration. Add the client's host name, or let the client use a metadata
  document, which the list does not apply to.
- **Metadata-document clients** keep only `https` addresses on the client id's own host, and loopback ones. A document that
  lists nothing else is refused as a whole: the audit has `oauth.client.refused` with a stable reason and the document's
  host, never its contents.
- **A request that names another redirect address** than the one registered is refused with an error page, not a redirect:
  the server never sends a code to an address that is not registered.

## Sign-in and consent

Sign-in belongs to your [identity provider](identity-providers.md#when-sign-in-fails); the reasons it writes to the audit
apply here too. The ones seen in the real run on 2026-10-26 with Cloudflare Access:

| Audit reason (kind `auth`) | Meaning | Fix |
|---|---|---|
| `missing_assertion` | Cloudflare Access did not send its header: the request did not pass through the Access application | The Access application must cover `/auth/cf-access`, `/auth/setup` **and** `/auth/reauth` (L-262). The first setup-link attempt failed here |
| `not_allowed` | No user for this identity and no allowlist entry; also what a plain sign-in shows when you meant to use the setup link (the code after `#` was lost on the way back from Access) | Add the user, or open the setup link again from the start |
| `reauth_stale` | A sign-in again (before a sensitive change) came with an Access assertion older than 10 minutes | Retry: Access issues a fresh one. Keep the Access **session duration short** (15 minutes) |

The first re-authentication in the real run was refused as `reauth_stale` and the retry worked.

On the consent page:

| You see | Audit row | Meaning and fix |
|---|---|---|
| "You have no access to this workspace" | none | No live grant on it: ask an administrator ([access model](access-model.md)) |
| "This form was already used" / "for another request" | `oauth.consent.refused` (`handle_used_or_expired`, `handle_mismatch`) | The page was sent twice, is old, or belongs to another connection: start again from the app |
| The chosen access is not offered | `oauth.consent.refused` (`grant_not_offered`) | The access ended while the page was open: reload |
| The app asked for changes but the page has no *allow changes* box, or write tools are missing after connecting | the server switch for writes, the workspace's *Allow writes*, the grant's tool list and whether the credential is personal; the `oauth.authorize` row's `scope` shows what was granted | Fix the layer an owner left off, then disconnect the app on My access and connect it again, ticking the box (a refresh never adds the scope) |
| "Too many connected apps" | none | 25 is the limit: disconnect one on **My access** |
| The app gets "access denied" | `oauth.authorize` denied (`user_denied`) | You chose **Deny** |
| The app never shows a page | none | A request with `prompt=none` is never shown a page and is answered `login_required` or `consent_required`: the app must use a normal sign-in |

## Registration caps and 429

A `429` with `Retry-After` comes from a limit, never from a fault. Each limit is audited once per window as
`oauth.request.refused` (the surface, `scope` `address` or `deployment`, and the limit; never an address).

| Surface | Per address | In all | Window |
|---|---|---|---|
| Authorization (`/oauth/authorize`) | 30 | 600 | 10 minutes |
| Consent posts | 30 | 300 | 10 minutes |
| Failed token requests | 20 | 300 (only addresses that already failed) | 10 minutes |
| Registrations (`/oauth/register`) | 10 | 100, and 200 live | 1 hour |
| Metadata-document fetches | 20 | 200 | 1 hour |

A team behind one office address can reach the per-address numbers when everyone connects at once: wait out the
`Retry-After`, or raise the `AB_OAUTH_*_LIMIT` settings ([configuration](configuration.md)). The deployment-wide numbers are
reached only by many addresses together: look at who is registering (**OAuth apps** in the admin panel, where an owner can
revoke what looks wrong), and consider `AB_OAUTH_DCR=off` if all your clients use metadata documents
([D-68](oauth-operator.md#how-clients-register)). Registrations nobody finishes are removed after 24 hours.

## Not found on an item that exists

A tool answers "not found" for something you can see in Agility. In the 2026-10-26 run, listing a sprint's tasks worked and
fetching one task did not: the task belonged to a **release project** outside the workspace's project tree. The server adds
the workspace's projects to every query and caller input cannot widen them, and an out-of-scope item answers exactly like a
missing one (L-263).

1. In the admin panel open the workspace and look at its **projects**.
2. Add the project the item lives in, or better the **parent** that covers both the team's projects and their releases.
3. Ask again. No reconnect is needed: the scope is checked on every call.

If it still fails, check the grant's own tools and project restriction on **My access** ([access model](access-model.md)).

## Disconnect, reconnect and refresh

- **Disconnect** on **My access** (or by an administrator on **Connected apps**) ends the app's tokens at once. The app's next
  call is a `401` and it shows "authentication needed": choose Authenticate, or connect again. Connecting the same app to the
  same workspace again replaces the earlier entry once the new connection works.
- **Asked to connect again after weeks:** the refresh token lives 30 days (`AB_OAUTH_REFRESH_TTL`).
- **Asked again after minutes or hours, with `oauth.refresh.reuse` in the audit:** the app presented a refresh token that was
  already spent, after the 30 second window, and the bridge ended the whole device because it cannot tell a stolen copy from
  a broken app ([how it works](oauth-how-it-works.md#why-a-repeat-is-tolerated-for-30-seconds)). Approve the app again. If one
  client does it repeatedly, give it a longer `AB_OAUTH_REFRESH_REUSE_WINDOW` (up to 120 seconds) or report the client.
- **`oauth.token.refused` with a reason:** the check on every use failed, and `details.revoked` says what happened to the
  device. `revoked: true` (the client was revoked, `client_revoked`, the access was withdrawn, expired or deleted, or the
  person was removed): the device is disconnected; fix the cause and connect again. `revoked: false` (`workspace_disabled`,
  `instance_disabled`, `user_disabled`, `credential_revoked`, `credential_unvalidated`, `no_projects`, `no_tools`): the app
  got `503 temporarily_unavailable` with `Retry-After: 60` and the device is **kept**. Switch the workspace or person back
  on, replace or validate the credential, or give the access a project and a tool, and the app's next refresh works with
  no new approval. Until then every call with its access token is a `401`.
- **`oauth.code.replayed`:** an authorization code was used twice (a retried request, or something copied the address from
  the browser). The device is revoked as a precaution: connect again.

## Still stuck

Collect the client and its version, the time, the audit rows around it (no tokens are in them) and the output of the three
`curl` commands at the top, and open an issue as described in [troubleshooting](troubleshooting.md).
