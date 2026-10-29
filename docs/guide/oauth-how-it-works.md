# How OAuth sign-in and tokens work

> For people who run `agility-bridge serve` or the Cloudflare Worker with `AB_OAUTH=on`, and for anyone who wonders why an
> app asked them to connect again. Step by step: [claude.ai and a phone](oauth-phone.md), [IDEs and CLIs](oauth-ides.md).
> Turning it on: [operator guide](oauth-operator.md). When it fails: [troubleshooting](oauth-troubleshooting.md). Developer
> details: [OAuth server](../dev/oauth.md).

## From "add a server" to "connected"

1. **Discovery.** The app calls the workspace address (`/w/<slug>/mcp`) without a token and gets a `401` whose
   `WWW-Authenticate` header names the **protected resource metadata** (`/.well-known/oauth-protected-resource/w/<slug>/mcp`).
   That document names the authorization server, and the server's own metadata (`/.well-known/oauth-authorization-server`)
   lists the endpoints. Both are public and the same for every workspace name, so they tell nobody which workspaces exist.
2. **Registration.** The app identifies itself: either by a **client metadata document** (its client id is an `https` URL the
   server fetches; claude.ai and Claude Code do this) or by **dynamic registration** at `/oauth/register`. Redirect
   addresses must be `https` or loopback; private-use schemes such as `cursor://` are refused.
3. **Sign-in and consent.** The browser opens `/oauth/authorize`. You sign in with the server's identity provider, see who is
   asking, where the answer goes and which of your own accesses it would get, and choose Allow or Deny. The app name is never
   verified, so only approve a connection you just started.
4. **Tokens.** The app swaps the one-use code (with its PKCE proof) for the tokens below, bound to this one workspace.

Each step has its own failure and its own audit row: [troubleshooting](oauth-troubleshooting.md).

## Changes (the `mcp:write` scope)

By default an app connected by OAuth can only **read**. An app that wants to change work items asks for the `mcp:write` scope
too, and then the consent page shows a separate box, **Also allow this app to ask for changes**, which is **never ticked for
you** and is asked again at every connection (nothing is remembered). The box appears only if the server owner turned writes
on and the access you chose can write: its workspace allows writes, its grant names a write tool and it uses your own Agility
credential. Ticked, the app still cannot change anything without your approval of each change ([write tools](write-tools.md)).
A refresh never adds the scope: to give a read-only app changes later, disconnect it on **My access** and connect it again.
Disconnecting removes both reading and changing at once.

**Which apps can ask for changes.** The **Changes** column on **My access** (and on the administrators' **Connected apps**
list) marks each app **can ask for changes** (its authorization holds `mcp:write`) or **read only**. It says what the app was
given when it connected, not that a change would go through today: the server switch, the workspace, the grant and your own
credential still decide that, and each change still needs your approval. The scope itself is never shown, and it cannot be
changed in place: disconnect the app to remove it. The same fact is `canWrite` in `GET /api/admin/v1/me/oauth-devices` and
`GET /api/admin/v1/oauth/devices`.

## The short version

An app (claude.ai, Claude on a phone, an IDE) that connects by OAuth does not hold your Agility token or a long-lived
secret that you typed. It holds two short-lived tokens that the bridge issued after you approved it:

| Token | Lives | What it does |
|---|---|---|
| **Access token** | 1 hour by default | Sent with every request to `/w/<workspace>/mcp`. The bridge checks your access again with every use, so a change in the access model takes effect within the [cache time](configuration.md). |
| **Refresh token** | 30 days by default, from the day you approved | Used by the app, and only by the app, to get a new access token when the old one runs out. |

Neither token is shown to you, and neither works anywhere but the one workspace you approved.

## Staying connected: rotation

Every time the app refreshes, the bridge hands it a **new** access token **and a new** refresh token and retires the old
refresh token. A refresh token is therefore good for one use. If someone copied it from a log or a backup of the app's
own files, it is worth nothing after the app's next refresh.

## Why a repeat is tolerated for 30 seconds

Apps do not refresh politely. When an access token expires, a client that is running several tool calls at once sends
several refreshes at the same moment, each with the same refresh token. A phone can also lose the answer to a refresh
(a tunnel, a dropped connection) and send the same request again. Strict one-use rotation would treat the second request
as theft and end the connection, and you would have to approve the app again for no reason.

So the bridge keeps a short **reuse window** (30 seconds; the operator can change it, from 0 to 120):

1. **One refresh does the work.** When several arrive together, one of them rotates the tokens. The others wait a moment
   and receive **the same new tokens**. The app ends up with one consistent set, however many requests it sent.
2. **A repeat inside the window gets the same answer.** The bridge keeps the new tokens, encrypted, for the window only.
   After 30 seconds they are deleted.
3. **A repeat after the window ends the connection.** A spent refresh token that comes back later is either a stolen copy
   or a broken app, and the bridge cannot tell which. It disconnects the **whole device**: the access token and the
   refresh token of that app stop working at once, and the app has to be approved again. The event is written to the
   [audit log](audit-log.md) as `oauth.refresh.reuse`, with the device and the app, and never with a token.

A window of `0` is strict single use: a second request with the same token, even a simultaneous one, ends the
connection. Use it only for clients you know refresh one at a time.

What the window costs: for those 30 seconds, whoever holds a refresh token that was *just* spent could ask for the new
tokens too. That is the price of tolerating parallel refreshes. The new tokens are readable only with the spent token
(see below), the window is short, and the app's next refresh makes the thief's copy useless.

## When a refresh is refused

Every refresh, including a repeat inside the window, first checks that the device is still connected and that you still
have the access it was approved with:

- You pressed **Disconnect** in **My access** ([connect a phone](oauth-phone.md#see-and-disconnect-your-apps)), or the app
  was replaced by connecting the same app again, or it was one of more than 25 apps and was pushed out: the app cannot
  refresh. It has to be approved again.
- Your access on the workspace was **withdrawn for good** (the access grant was revoked, ended or deleted, or your account
  was removed), or the app's registration was revoked: the refresh is refused (`invalid_grant`) and the device is
  disconnected. The app has to be approved again.
- Something is **switched off for now**: the workspace, its Agility instance or your account is disabled, the credential
  was revoked or is not validated, or the access was left with no project or no tool. The refresh is answered `503` with
  `Retry-After: 60` and **the device is kept**: the app should wait and try again, and once the cause is fixed its next
  refresh works with no new approval. Meanwhile every request with the app's access token is refused too, so nothing is
  reachable while the cause holds. (An approval code being exchanged at that moment is spent: the app starts the approval
  again, and nothing else you connected is affected.)
- The 30 days are over: the app is asked to sign in again.

## What is stored

Nothing the bridge stores can be used as a token.

- Access and refresh tokens are stored as **hashes** only, as are authorization codes.
- The "just rotated" record is a hash of the old refresh token and a time.
- The new tokens kept for the reuse window are **encrypted** with a key made from the old refresh token itself. A copy
  of the database or of a backup does not contain that key, so it cannot open them, and they are gone after the window.
- The audit log and the server log name the device and the app, never a token. Tests scan the database file, the audit
  log and the logs for token text after complete flows.

## For the operator

Turning OAuth on and the registration settings are in the [operator guide](oauth-operator.md).

| Setting | Default | Range |
|---|---|---|
| `AB_OAUTH_ACCESS_TTL` | `1h` | 60 s to 24 h |
| `AB_OAUTH_REFRESH_TTL` | `30d` | 1 h to 365 d, not shorter than the access lifetime |
| `AB_OAUTH_REFRESH_REUSE_WINDOW` | `30s` | 0 to 120 s, not longer than the access lifetime; `0` is strict single use |

A value outside its range stops the server at start with a message naming the setting. See
[configuration](configuration.md#server-mode-agility-bridge-serve) for the full list. If people report being asked to reconnect
often, look for `oauth.refresh.reuse` rows in the [audit log](audit-log.md): a client that refreshes twice, seconds
apart, outside the window needs a longer window or a fix on its side.
