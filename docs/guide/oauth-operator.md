# Turn on OAuth (operator guide)

> For whoever runs `agility-bridge serve` or the Cloudflare Worker. OAuth is **off by default**; with it on, apps that
> cannot hold a device token (claude.ai, Claude on a phone, most IDEs) connect by signing in and approving. People: [connect
> claude.ai and a phone](oauth-phone.md), [connect an IDE or CLI](oauth-ides.md). Why a connection fails:
> [troubleshooting OAuth](oauth-troubleshooting.md). Token behaviour: [how it works](oauth-how-it-works.md).

## Before you start

1. **Public HTTPS.** claude.ai calls your server from Anthropic's cloud, so the address must be reachable from the
   internet with a publicly trusted certificate, on IPv4. Set `AB_PUBLIC_URL` to it (`https://bridge.example.com`, no
   path). The server answers only requests for that host (DNS rebinding, `AB_ALLOWED_HOSTS` adds more) and uses it as the
   OAuth **issuer**: change it and every connected app has to be approved again.
2. **A sign-in provider** ([identity providers](identity-providers.md)): Google, GitHub, an OIDC provider or Cloudflare
   Access. People approve an app after signing in. Without one the server refuses to start with
   `AB_OAUTH=on needs sign-in (an identity provider ...)`.
3. **A workspace and a grant** for each person ([access model](access-model.md)). An app gets exactly one access the
   person already has, never more. Check the workspace's **projects**: an item outside the project tree answers "not
   found" ([L-263](oauth-troubleshooting.md#not-found-on-an-item-that-exists)).
4. **If a proxy or Cloudflare Access sits in front**, leave `/w/*`, `/oauth/*` and `/.well-known/*` outside it. Apps cannot
   pass an Access login page. Only the sign-in paths belong in an Access application.

## Node (`agility-bridge serve`)

Add `AB_OAUTH=on` next to the sign-in settings and restart:

```sh
AB_PUBLIC_URL=https://bridge.example.com \
AB_OAUTH=on \
AB_GOOGLE_CLIENT_ID=... AB_GOOGLE_CLIENT_SECRET_FILE=/etc/agility-bridge/google.secret \
AB_MASTER_KEY_FILE=/etc/agility-bridge/master.key \
agility-bridge serve
```

Verified on 2026-10-27 with the built CLI: with a (fake) Google client the server starts, `GET
/.well-known/oauth-protected-resource/w/<slug>/mcp` and a tokenless `POST /w/<slug>/mcp` behave as in
[troubleshooting](oauth-troubleshooting.md#discovery), a wrong `Host` gets `403`, and with no provider it stops with the message above.
In systemd or Docker the settings are `Environment=` lines or `-e` flags like the others
([self-hosting](self-hosting.md)).

## Cloudflare Worker

`pnpm cf:setup` can switch OAuth on and keeps it on:

```sh
pnpm cf:setup --name agility-bridge --domain bridge.example.com --secrets-file ~/.config/agility-bridge/prod.secrets --oauth on
```

`--oauth on|off` writes `AB_OAUTH` into the ignored `apps/worker/wrangler.<name>.local.jsonc`; **a later run without the
flag keeps the value** (the script reads it back from that file), so a routine `cf:setup` or `--sign-in` run never turns
OAuth off by accident. `cf:setup` warns when OAuth is on but no sign-in variable is in the config (set it with
`--sign-in`, or in the dashboard). Before 2026-10-27 the script did not manage `AB_OAUTH`; a deployment that has it as
a variable in the config keeps working: the script reads whatever the local config already holds.

`wrangler.jsonc` already carries the `global_fetch_strictly_public` flag that metadata-document clients need
([configuration](configuration.md), `AB_OAUTH_CIMD`). The rest of the Worker setup is in the
[deploy guide](cloudflare-deploy.md); sign-in through Cloudflare Access needs the three paths of
[its section](identity-providers.md#cloudflare-access) and a short Access session, because re-authentication accepts an
assertion of the last 10 minutes only.

## How clients register

Two ways, both on by default:

| Way | Setting | What happens |
|---|---|---|
| **Client ID Metadata Document (CIMD)** | `AB_OAUTH_CIMD` (`on`) | The client's id is an `https` URL. The server fetches the JSON document there (public addresses only, no redirects, 5 KiB, 5 s), checks it and stores it for its cache lifetime. claude.ai and Claude Code connect this way: nothing is registered by hand, and the consent page shows the document's host as the one vouching for the name. |
| **Dynamic client registration (DCR)** | `AB_OAUTH_DCR` (`on`) | The client posts its redirect addresses to `/oauth/register` and gets a client id. Anyone can call it, so it is capped (below). `off` answers `404`. |

**D-68 (decided 2026-10-26): DCR stays on by default, capped.** It is the compatibility path for clients that cannot use
documents. The real runs so far used documents only, so once your clients are known to use them, set `AB_OAUTH_DCR=off`
to close the one anonymous write endpoint. Until then:

- `AB_OAUTH_DCR_IP_LIMIT` (10 per address and hour), `AB_OAUTH_DCR_MAX_CLIENTS` (200 live), `AB_OAUTH_DCR_LIMIT` (100 per
  hour in all) and `AB_OAUTH_DCR_UNUSED_TTL` (a registration nobody used goes after 24 h). Over a cap: `429` with
  `Retry-After`.
- `AB_OAUTH_DCR_REDIRECT_HOSTS`: the only `https` hosts a dynamic client may send people back to (for example
  `claude.ai`); loopback addresses are always allowed.
- Registered clients show on **OAuth apps** in the [admin panel](admin-panel.md) where an owner can revoke one.

**D-69 (decided 2026-10-26): private-use redirect schemes are not accepted.** A callback such as `cursor://...` can be
claimed by any program on a computer, so the server keeps only `https` addresses and loopback `http` (`127.0.0.1`, `[::1]`)
and drops the rest; a registration left with none is refused as `invalid_redirect_uri`. No client has needed one yet; if
one does, the work is task P5-15 and the consent page would have to show the scheme.

The full list of limits (authorization, consent and token failures) is in [configuration](configuration.md); the design is
in [OAuth abuse controls](../dev/oauth.md#abuse-controls-p5-09).

## Check it works

From any machine, with no credentials (this is what the runs on 2026-10-27 did against a real Worker):

```sh
curl -s https://bridge.example.com/health
curl -s https://bridge.example.com/.well-known/oauth-authorization-server
curl -s https://bridge.example.com/.well-known/oauth-protected-resource/w/my-team/mcp
curl -si -X POST https://bridge.example.com/w/my-team/mcp -H 'Content-Type: application/json' -d '{}'
```

You should see `{"status":"ok"}`; a document whose `issuer` is your public URL, with `authorization_endpoint`,
`token_endpoint`, `registration_endpoint` (absent when DCR is off), `code_challenge_methods_supported: ["S256"]` and
`client_id_metadata_document_supported: true`; a `resource` document naming `https://bridge.example.com/w/my-team/mcp`;
and `401` with `WWW-Authenticate: Bearer ... resource_metadata="https://bridge.example.com/.well-known/oauth-protected-resource/w/my-team/mcp"`.
Metadata is the same for every workspace name, existing or not, so these calls reveal nothing about your workspaces. Then
connect an app yourself ([claude.ai](oauth-phone.md), [Claude Code](oauth-ides.md#claude-code)) and look for
`oauth.authorize` and `oauth.token.issued` in the [audit log](audit-log.md).

## Day to day

- **People and apps:** *My access* lists a person's connected apps; **Connected apps** and **OAuth apps** in the admin panel
  list everyone's ([admin panel](admin-panel.md#connected-apps-and-oauth-apps-oauth-only)).
- **Turning OAuth off** (`AB_OAUTH=off`) makes `/oauth/*` and `/.well-known/*` answer `404` and the MCP route's `401` a bare `WWW-Authenticate: Bearer`; device
  tokens keep working. Connected apps stay in the database and work again if you turn it back on.
- **Lifetimes** (`AB_OAUTH_ACCESS_TTL`, `AB_OAUTH_REFRESH_TTL`, `AB_OAUTH_REFRESH_REUSE_WINDOW`): [how it works](oauth-how-it-works.md#for-the-operator).
